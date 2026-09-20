#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdbool.h>

struct sfs_directory_entry {
  char *name;
  struct stat attributes;
};

struct sfs_listing {
  struct sfs_directory_entry *entries;
  size_t length, capacity;
  int error;
  bool ready;
};

struct sfs_handle {
  struct fuse_file_info info;
  bool directory;
  unsigned readers;
  struct sfs_listing listing;
  struct sfs_handle *next;
};

struct sfs_alias {
  char *name;
  struct sfs_node *parent;
  struct sfs_alias *next;
};

struct sfs_node {
  fuse_ino_t ino;
  ino_t identity;
  dev_t device;
  char *name;
  char *symlink_target;
  struct sfs_node *parent;
  struct stat attributes;
  uint64_t lookups;
  unsigned active, children;
  bool linked;
  struct sfs_alias *aliases;
  struct sfs_handle *handles;
  struct sfs_node *next;
};

struct sfs_mount {
  struct fuse_session *session;
  struct fuse_operations ops;
  int (*fsetattr)(const char *, struct stat *, int, struct fuse_file_info *);
  void *userdata;
  struct sfs_node *nodes;
  fuse_ino_t next_ino;
  pthread_mutex_t mutex, namespace;
  pthread_cond_t released;
};

static _Thread_local struct fuse_context sfs_context;
static _Thread_local int (*sfs_pending_fsetattr)(
  const char *, struct stat *, int, struct fuse_file_info *);

static void sfs_set_fsetattr(
    int (*fsetattr)(const char *, struct stat *, int, struct fuse_file_info *)) {
  sfs_pending_fsetattr = fsetattr;
}

static struct fuse_context *sfs_get_context(void) {
  return &sfs_context;
}

static struct sfs_mount *sfs_enter(fuse_req_t req) {
  struct sfs_mount *mount = fuse_req_userdata(req);
  const struct fuse_ctx *ctx = fuse_req_ctx(req);
  sfs_context = (struct fuse_context){
    .uid = ctx->uid, .gid = ctx->gid, .pid = ctx->pid,
    .private_data = mount->userdata
  };
  return mount;
}

static struct sfs_node *sfs_find(struct sfs_mount *mount, fuse_ino_t ino) {
  for (struct sfs_node *node = mount->nodes; node; node = node->next)
    if (node->ino == ino) return node;
  return NULL;
}

static bool sfs_same_identity(struct sfs_node *node, const struct stat *attributes) {
  // Recycled backing inode numbers must not revive a retained zero-link inode.
  return node->identity == attributes->st_ino && node->device == attributes->st_dev &&
    (node->attributes.st_nlink != 0 || attributes->st_nlink == 0);
}

static struct sfs_node *sfs_child(struct sfs_mount *mount,
                                 struct sfs_node *parent, const char *name) {
  for (struct sfs_node *node = mount->nodes; node; node = node->next) {
    if (node->linked && node->parent == parent && !strcmp(node->name, name))
      return node;
    for (struct sfs_alias *alias = node->aliases; alias; alias = alias->next)
      if (alias->parent == parent && !strcmp(alias->name, name)) return node;
  }
  return NULL;
}

static void sfs_collect(struct sfs_mount *mount, struct sfs_node *node) {
  while (node && node->ino != FUSE_ROOT_ID && !node->lookups &&
         !node->active && !node->children && !node->handles) {
    struct sfs_node **slot = &mount->nodes;
    while (*slot && *slot != node) slot = &(*slot)->next;
    if (*slot) *slot = node->next;
    struct sfs_node *parent = node->parent;
    while (node->aliases) {
      struct sfs_alias *alias = node->aliases;
      node->aliases = alias->next;
      alias->parent->children--;
      sfs_collect(mount, alias->parent);
      free(alias->name);
      free(alias);
    }
    if (parent) parent->children--;
    free(node->name);
    free(node->symlink_target);
    free(node);
    node = parent;
  }
}

static void sfs_unlink_name(struct sfs_mount *mount, struct sfs_node *node,
                            struct sfs_node *parent, const char *name) {
  if (node->parent == parent && !strcmp(node->name, name)) {
    if (node->aliases) {
      struct sfs_alias *alias = node->aliases;
      node->aliases = alias->next;
      free(node->name);
      node->name = alias->name;
      node->parent = alias->parent;
      node->linked = true;
      free(alias);
      parent->children--;
      sfs_collect(mount, parent);
    } else node->linked = false;
  } else {
    struct sfs_alias **slot = &node->aliases;
    while (*slot && ((*slot)->parent != parent || strcmp((*slot)->name, name)))
      slot = &(*slot)->next;
    if (*slot) {
      struct sfs_alias *alias = *slot;
      *slot = alias->next;
      free(alias->name);
      free(alias);
      parent->children--;
      sfs_collect(mount, parent);
    }
  }
}

// Lookup invalidation and alias promotion do not remove backing links.
static void sfs_remove_name(struct sfs_mount *mount, struct sfs_node *node,
                            struct sfs_node *parent, const char *name,
                            const struct stat *attributes) {
  if (attributes && sfs_same_identity(node, attributes))
    node->attributes = *attributes;
  if (S_ISDIR(node->attributes.st_mode)) node->attributes.st_nlink = 0;
  else if (node->attributes.st_nlink) node->attributes.st_nlink--;
  sfs_unlink_name(mount, node, parent, name);
}

static struct sfs_node *sfs_acquire(struct sfs_mount *mount, fuse_ino_t ino) {
  pthread_mutex_lock(&mount->mutex);
  struct sfs_node *node = sfs_find(mount, ino);
  if (node) node->active++;
  pthread_mutex_unlock(&mount->mutex);
  return node;
}

static void sfs_drop(struct sfs_mount *mount, struct sfs_node *node) {
  pthread_mutex_lock(&mount->mutex);
  node->active--;
  sfs_collect(mount, node);
  pthread_mutex_unlock(&mount->mutex);
}

static bool sfs_linked(struct sfs_node *node) {
  for (; node; node = node->parent)
    if (!node->linked) return false;
  return true;
}

static char *sfs_path_locked(struct sfs_node *node) {
  size_t length = 1;
  for (struct sfs_node *part = node; part->parent; part = part->parent)
    length += strlen(part->name) + 1;
  char *path = malloc(length + 1);
  if (!path) return NULL;
  path[length] = 0;
  size_t offset = length;
  for (struct sfs_node *part = node; part->parent; part = part->parent) {
    size_t size = strlen(part->name);
    offset -= size;
    memcpy(path + offset, part->name, size);
    path[--offset] = '/';
  }
  if (offset == length) path[--offset] = '/';
  memmove(path, path + offset, length - offset + 1);
  return path;
}

static char *sfs_path(struct sfs_mount *mount, struct sfs_node *node) {
  pthread_mutex_lock(&mount->mutex);
  char *path = sfs_path_locked(node);
  pthread_mutex_unlock(&mount->mutex);
  return path;
}

static int sfs_check_path(struct sfs_mount *mount, struct sfs_node *node,
                          const char *path);
static char *sfs_checked_path(struct sfs_mount *mount, struct sfs_node *node,
                              int *result);

static char *sfs_child_path(struct sfs_mount *mount, struct sfs_node *parent,
                           const char *name) {
  if (!*name || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, "..")) {
    errno = EINVAL;
    return NULL;
  }
  pthread_mutex_lock(&mount->mutex);
  bool linked = sfs_linked(parent);
  char *base = linked ? sfs_path_locked(parent) : NULL;
  pthread_mutex_unlock(&mount->mutex);
  if (!base) { errno = linked ? ENOMEM : ENOENT; return NULL; }
  int result = sfs_check_path(mount, parent, base);
  if (result) { free(base); errno = -result; return NULL; }
  size_t length = strlen(base) + strlen(name) + 2;
  char *path = malloc(length);
  if (path) snprintf(path, length, "%s%s%s", base, !strcmp(base, "/") ? "" : "/", name);
  free(base);
  if (!path) errno = ENOMEM;
  return path;
}

static int sfs_read_symlink(struct sfs_mount *mount, const char *path,
                            struct stat *attributes, char *target, size_t size) {
  int result = mount->ops.readlink(path, target, size);
  if (result) return result;
  if (!memchr(target, 0, size)) return -ENAMETOOLONG;
  struct stat current = {0};
  result = mount->ops.getattr(path, &current);
  if (result) return result;
  if (!S_ISLNK(current.st_mode) || current.st_ino != attributes->st_ino ||
      current.st_dev != attributes->st_dev) return -ESTALE;
  *attributes = current;
  return 0;
}

static struct sfs_node *sfs_register(struct sfs_mount *mount,
                                    struct sfs_node *parent, const char *name,
                                    const struct stat *attributes,
                                    const char *symlink_target) {
  struct sfs_node *node = sfs_child(mount, parent, name);
  if (node && (!sfs_same_identity(node, attributes) ||
               (node->attributes.st_mode & S_IFMT) != (attributes->st_mode & S_IFMT) ||
               (S_ISLNK(attributes->st_mode) &&
                (!node->symlink_target || !symlink_target ||
                 strcmp(node->symlink_target, symlink_target))))) {
    sfs_unlink_name(mount, node, parent, name);
    sfs_collect(mount, node);
    node = NULL;
  }
  if (!node && attributes->st_ino && S_ISREG(attributes->st_mode) &&
      attributes->st_nlink > 0) {
    for (struct sfs_node *candidate = mount->nodes; candidate; candidate = candidate->next) {
      if (!sfs_same_identity(candidate, attributes) ||
          !S_ISREG(candidate->attributes.st_mode)) continue;
      struct sfs_alias *alias = calloc(1, sizeof(*alias));
      if (!alias) return NULL;
      alias->name = strdup(name);
      if (!alias->name) { free(alias); return NULL; }
      alias->parent = parent;
      alias->next = candidate->aliases;
      candidate->aliases = alias;
      parent->children++;
      if (!candidate->linked)
        sfs_unlink_name(mount, candidate, candidate->parent, candidate->name);
      node = candidate;
      break;
    }
  }
  if (!node) {
    node = calloc(1, sizeof(*node));
    if (!node) return NULL;
    node->name = strdup(name);
    if (!node->name) { free(node); return NULL; }
    if (symlink_target) {
      node->symlink_target = strdup(symlink_target);
      if (!node->symlink_target) { free(node->name); free(node); return NULL; }
    }
    node->ino = mount->next_ino++;
    node->parent = parent;
    node->identity = attributes->st_ino;
    node->device = attributes->st_dev;
    node->linked = true;
    node->next = mount->nodes;
    mount->nodes = node;
    parent->children++;
  }
  node->attributes = *attributes;
  if (node->symlink_target) node->attributes.st_size = strlen(node->symlink_target);
  node->lookups++;
  return node;
}

static void sfs_entry(struct sfs_node *node, struct fuse_entry_param *entry) {
  memset(entry, 0, sizeof(*entry));
  entry->ino = node->ino;
  entry->generation = 1;
  entry->attr = node->attributes;
  entry->attr.st_ino = node->ino;
}

static int sfs_stat(struct sfs_mount *mount, struct sfs_node *node,
                    struct fuse_file_info *info, struct stat *attributes) {
  struct sfs_handle *pinned = NULL;
  struct fuse_file_info retained;
  pthread_mutex_lock(&mount->mutex);
  char *path = sfs_path_locked(node);
  if (!info && node->handles) {
    pinned = node->handles;
    pinned->readers++;
    retained = pinned->info;
    info = &retained;
  }
  bool linked = sfs_linked(node);
  bool aliased = node->aliases != NULL;
  *attributes = node->attributes;
  pthread_mutex_unlock(&mount->mutex);

  int result = path ? 0 : -ENOMEM;
  if (!result && info && mount->ops.fgetattr)
    result = mount->ops.fgetattr(path, attributes, info);
  else if (!result && (linked || aliased)) {
    if (aliased) {
      free(path);
      path = sfs_checked_path(mount, node, &result);
    }
    if (!result) result = mount->ops.getattr(path, attributes);
  }

  pthread_mutex_lock(&mount->mutex);
  if (pinned) {
    pinned->readers--;
    pthread_cond_broadcast(&mount->released);
  }
  // O_PATH has no backing handle; loss of a pathname must not invalidate its inode.
  if (!info && node->ino != FUSE_ROOT_ID &&
      (result == -ENOENT || result == -ENOTDIR || result == -ESTALE)) {
    *attributes = node->attributes;
    result = 0;
  }
  if (!result) {
    if (node->ino != FUSE_ROOT_ID &&
        (!sfs_same_identity(node, attributes) ||
         (node->attributes.st_mode & S_IFMT) != (attributes->st_mode & S_IFMT)))
      *attributes = node->attributes;
    else {
      if (node->symlink_target) attributes->st_size = strlen(node->symlink_target);
      node->attributes = *attributes;
    }
    attributes->st_ino = node->ino;
  }
  pthread_mutex_unlock(&mount->mutex);
  free(path);
  return result;
}

static void sfs_lookup(fuse_req_t req, fuse_ino_t ino, const char *name) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *parent = sfs_acquire(mount, ino);
  if (!parent) { fuse_reply_err(req, ESTALE); return; }
  pthread_mutex_lock(&mount->namespace);
  char *path = sfs_child_path(mount, parent, name);
  struct stat attributes = {0};
  int result = path ? mount->ops.getattr(path, &attributes) : -errno;
  // O_PATH retains an inode without an open callback.
  char symlink_target[PATH_MAX + 1] = {0};
  if (!result && S_ISLNK(attributes.st_mode))
    result = sfs_read_symlink(mount, path, &attributes, symlink_target, sizeof(symlink_target));
  struct sfs_node *node = NULL;
  struct fuse_entry_param entry;
  pthread_mutex_lock(&mount->mutex);
  if (!result) {
    node = sfs_register(mount, parent, name, &attributes,
      S_ISLNK(attributes.st_mode) ? symlink_target : NULL);
    if (!node) result = -ENOMEM;
    else sfs_entry(node, &entry);
  } else if (result == -ENOENT) {
    node = sfs_child(mount, parent, name);
    if (node) {
      sfs_unlink_name(mount, node, parent, name);
      sfs_collect(mount, node);
    }
    node = NULL;
  }
  if (result) fuse_reply_err(req, -result);
  else if (fuse_reply_entry(req, &entry)) {
    node->lookups--;
    sfs_collect(mount, node);
  }
  pthread_mutex_unlock(&mount->mutex);
  free(path);
  pthread_mutex_unlock(&mount->namespace);
  sfs_drop(mount, parent);
}

static void sfs_forget(fuse_req_t req, fuse_ino_t ino, unsigned long count) {
  struct sfs_mount *mount = sfs_enter(req);
  pthread_mutex_lock(&mount->mutex);
  struct sfs_node *node = sfs_find(mount, ino);
  if (node) {
    node->lookups = count > node->lookups ? 0 : node->lookups - count;
    sfs_collect(mount, node);
  }
  pthread_mutex_unlock(&mount->mutex);
  fuse_reply_none(req);
}

static void sfs_getattr(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *info) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *node = sfs_acquire(mount, ino);
  if (!node) { fuse_reply_err(req, ESTALE); return; }
  pthread_mutex_lock(&mount->namespace);
  struct stat attributes;
  int result = sfs_stat(mount, node, info, &attributes);
  if (result) fuse_reply_err(req, -result);
  else fuse_reply_attr(req, &attributes, 0);
  pthread_mutex_unlock(&mount->namespace);
  sfs_drop(mount, node);
}

static void sfs_free_listing(struct sfs_listing *listing) {
  for (size_t index = 0; index < listing->length; index++)
    free(listing->entries[index].name);
  free(listing->entries);
  *listing = (struct sfs_listing){0};
}

static int sfs_close(struct sfs_mount *mount, struct sfs_node *node,
                     struct fuse_file_info *info, bool directory) {
  pthread_mutex_lock(&mount->mutex);
  struct sfs_handle **slot = &node->handles;
  while (*slot && ((*slot)->info.fh != info->fh || (*slot)->directory != directory))
    slot = &(*slot)->next;
  struct sfs_handle *handle = *slot;
  if (handle) {
    *slot = handle->next;
    while (handle->readers) pthread_cond_wait(&mount->released, &mount->mutex);
  }
  bool last = handle && !node->handles;
  char *path = sfs_path_locked(node);
  pthread_mutex_unlock(&mount->mutex);
  int result = -EBADF;
  if (handle) {
    result = -ENOMEM;
    if (path) {
      int metadata_result = 0;
      if (last && mount->ops.fgetattr) {
        // O_PATH may retain this inode after its final backing handle disappears.
        struct stat attributes;
        metadata_result = sfs_stat(mount, node, info, &attributes);
        if (metadata_result)
          fprintf(stderr, "scriptfs: final handle metadata failed: %d\n", metadata_result);
      }
      result = directory ? mount->ops.releasedir(path, info) : mount->ops.release(path, info);
      if (!result) result = metadata_result;
    }
  }
  free(path);
  if (handle) sfs_free_listing(&handle->listing);
  free(handle);
  return result;
}

static int sfs_open_attributes(struct sfs_mount *mount, struct sfs_node *node,
                               const char *path, struct fuse_file_info *info,
                               bool directory, struct stat *attributes) {
  int result = mount->ops.fgetattr(path, attributes, info);
  if (!result && node->ino != FUSE_ROOT_ID &&
      (!sfs_same_identity(node, attributes) ||
       (node->attributes.st_mode & S_IFMT) != (attributes->st_mode & S_IFMT)))
    result = -ESTALE;
  if (!result && !directory && (info->flags & O_TRUNC)) {
    result = mount->ops.ftruncate(path, 0, info);
    if (!result) result = mount->ops.fgetattr(path, attributes, info);
    if (!result &&
        (!sfs_same_identity(node, attributes) ||
         (node->attributes.st_mode & S_IFMT) != (attributes->st_mode & S_IFMT)))
      result = -ESTALE;
  }
  return result;
}

static void sfs_open_common(fuse_req_t req, fuse_ino_t ino,
                            struct fuse_file_info *info, bool directory) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *node = sfs_acquire(mount, ino);
  if (!node) { fuse_reply_err(req, ESTALE); return; }
  pthread_mutex_lock(&mount->namespace);
  struct sfs_handle *handle = calloc(1, sizeof(*handle));
  int result = 0;
  char *path = sfs_checked_path(mount, node, &result);
  if (!handle) result = -ENOMEM;
  if (!result) result = directory ? mount->ops.opendir(path, info) : mount->ops.open(path, info);
  if (!result) {
    struct stat attributes = {0};
    result = sfs_open_attributes(mount, node, path, info, directory, &attributes);
    if (result) {
      int cleanup = directory ? mount->ops.releasedir(path, info) : mount->ops.release(path, info);
      if (cleanup) fprintf(stderr, "scriptfs: failed open cleanup: %d\n", cleanup);
    } else {
      handle->info = *info;
      handle->directory = directory;
      pthread_mutex_lock(&mount->mutex);
      node->attributes = attributes;
      handle->next = node->handles;
      node->handles = handle;
      pthread_mutex_unlock(&mount->mutex);
    }
  }
  if (result) { free(handle); fuse_reply_err(req, -result); }
  else if (fuse_reply_open(req, info)) {
    int cleanup = sfs_close(mount, node, info, directory);
    if (cleanup) fprintf(stderr, "scriptfs: interrupted open cleanup: %d\n", cleanup);
  }
  free(path);
  pthread_mutex_unlock(&mount->namespace);
  sfs_drop(mount, node);
}

static void sfs_open(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *info) {
  sfs_open_common(req, ino, info, false);
}
static void sfs_opendir(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *info) {
  sfs_open_common(req, ino, info, true);
}

static void sfs_create_common(fuse_req_t req, fuse_ino_t ino, const char *name,
                              mode_t mode, struct fuse_file_info *info) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *parent = sfs_acquire(mount, ino);
  if (!parent) { fuse_reply_err(req, ESTALE); return; }
  pthread_mutex_lock(&mount->namespace);
  char *path = sfs_child_path(mount, parent, name);
  struct sfs_handle *handle = info ? calloc(1, sizeof(*handle)) : NULL;
  int result = !path ? -errno : info && !handle ? -ENOMEM : 0;
  bool opened = false;
  struct stat attributes = {0};
  if (!result) {
    result = info ? mount->ops.create(path, mode, info) : mount->ops.mkdir(path, mode);
    opened = info && !result;
  }
  if (!result) result = info
    ? mount->ops.fgetattr(path, &attributes, info)
    : mount->ops.getattr(path, &attributes);
  struct sfs_node *node = NULL;
  struct fuse_entry_param entry;
  pthread_mutex_lock(&mount->mutex);
  if (!result) {
    node = sfs_register(mount, parent, name, &attributes, NULL);
    if (!node) result = -ENOMEM;
    else {
      node->active++;
      sfs_entry(node, &entry);
      if (handle) {
        handle->info = *info;
        handle->next = node->handles;
        node->handles = handle;
      }
    }
  }
  pthread_mutex_unlock(&mount->mutex);
  if (result) {
    if (opened) {
      int cleanup = mount->ops.release(path, info);
      if (cleanup) fprintf(stderr, "scriptfs: failed create cleanup: %d\n", cleanup);
    }
    free(handle);
    fuse_reply_err(req, -result);
  } else {
    int reply = info ? fuse_reply_create(req, &entry, info) : fuse_reply_entry(req, &entry);
    if (reply) {
      if (info) {
        int cleanup = sfs_close(mount, node, info, false);
        if (cleanup) fprintf(stderr, "scriptfs: interrupted create cleanup: %d\n", cleanup);
      }
      pthread_mutex_lock(&mount->mutex);
      node->lookups--;
      pthread_mutex_unlock(&mount->mutex);
    }
    sfs_drop(mount, node);
  }
  free(path);
  pthread_mutex_unlock(&mount->namespace);
  sfs_drop(mount, parent);
}

static void sfs_create(fuse_req_t req, fuse_ino_t ino, const char *name,
                        mode_t mode, struct fuse_file_info *info) {
  sfs_create_common(req, ino, name, mode, info);
}
static void sfs_mkdir(fuse_req_t req, fuse_ino_t ino, const char *name, mode_t mode) {
  sfs_create_common(req, ino, name, mode, NULL);
}

static void sfs_remove(fuse_req_t req, fuse_ino_t ino, const char *name, bool directory) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *parent = sfs_acquire(mount, ino);
  if (!parent) { fuse_reply_err(req, ESTALE); return; }
  pthread_mutex_lock(&mount->namespace);
  char *path = sfs_child_path(mount, parent, name);
  struct stat removed = {0};
  int result = path ? mount->ops.getattr(path, &removed) : -errno;
  if (!result) result = directory ? mount->ops.rmdir(path) : mount->ops.unlink(path);
  if (!result) {
    pthread_mutex_lock(&mount->mutex);
    struct sfs_node *node = sfs_child(mount, parent, name);
    if (node) {
      sfs_remove_name(mount, node, parent, name, &removed);
      sfs_collect(mount, node);
    }
    pthread_mutex_unlock(&mount->mutex);
  }
  free(path);
  fuse_reply_err(req, -result);
  pthread_mutex_unlock(&mount->namespace);
  sfs_drop(mount, parent);
}
static void sfs_unlink(fuse_req_t req, fuse_ino_t ino, const char *name) {
  sfs_remove(req, ino, name, false);
}
static void sfs_rmdir(fuse_req_t req, fuse_ino_t ino, const char *name) {
  sfs_remove(req, ino, name, true);
}

static void sfs_rename(fuse_req_t req, fuse_ino_t ino, const char *name,
                       fuse_ino_t destination, const char *new_name) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *parent = sfs_acquire(mount, ino);
  struct sfs_node *target = sfs_acquire(mount, destination);
  if (!parent || !target) {
    if (parent) sfs_drop(mount, parent);
    if (target) sfs_drop(mount, target);
    fuse_reply_err(req, ESTALE);
    return;
  }
  pthread_mutex_lock(&mount->namespace);
  char *from = sfs_child_path(mount, parent, name);
  int result = from ? 0 : -errno;
  char *to = result ? NULL : sfs_child_path(mount, target, new_name);
  if (!result && !to) result = -errno;
  char *replacement = strdup(new_name);
  if (!result && !replacement) result = -ENOMEM;
  pthread_mutex_lock(&mount->mutex);
  struct sfs_node *moved = sfs_child(mount, parent, name);
  if (moved) moved->active++;
  for (struct sfs_node *part = target; part; part = part->parent)
    if (part == moved) result = -EINVAL;
  pthread_mutex_unlock(&mount->mutex);
  struct stat removed = {0};
  bool target_exists = false;
  if (!result) {
    int target_result = mount->ops.getattr(to, &removed);
    if (target_result && target_result != -ENOENT) result = target_result;
    target_exists = !target_result;
  }
  if (!result) result = mount->ops.rename(from, to);
  if (!result && strcmp(from, to)) {
    pthread_mutex_lock(&mount->mutex);
    struct sfs_node *replaced = sfs_child(mount, target, new_name);
    if (replaced && replaced != moved) {
      sfs_remove_name(mount, replaced, target, new_name, target_exists ? &removed : NULL);
      sfs_collect(mount, replaced);
    }
    if (moved && moved != replaced) {
      struct sfs_node **old_parent = &moved->parent;
      char **old_name = &moved->name;
      if (moved->parent != parent || strcmp(moved->name, name)) {
        for (struct sfs_alias *alias = moved->aliases; alias; alias = alias->next) {
          if (alias->parent == parent && !strcmp(alias->name, name)) {
            old_parent = &alias->parent;
            old_name = &alias->name;
            break;
          }
        }
      }
      (*old_parent)->children--;
      *old_parent = target;
      target->children++;
      free(*old_name);
      *old_name = replacement;
      replacement = NULL;
    }
    pthread_mutex_unlock(&mount->mutex);
  }
  if (moved) sfs_drop(mount, moved);
  free(from); free(to); free(replacement);
  fuse_reply_err(req, -result);
  pthread_mutex_unlock(&mount->namespace);
  sfs_drop(mount, parent);
  sfs_drop(mount, target);
}

static void sfs_read(fuse_req_t req, fuse_ino_t ino, size_t size,
                     off_t offset, struct fuse_file_info *info) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *node = sfs_acquire(mount, ino);
  if (!node) { fuse_reply_err(req, ESTALE); return; }
  char *path = sfs_path(mount, node);
  char *buffer = malloc(size ? size : 1);
  int result = path && buffer ? mount->ops.read(path, buffer, size, offset, info) : -ENOMEM;
  if (result < 0 || (size_t) result > size) fuse_reply_err(req, result < 0 ? -result : EIO);
  else fuse_reply_buf(req, buffer, result);
  free(buffer); free(path);
  sfs_drop(mount, node);
}

static void sfs_write(fuse_req_t req, fuse_ino_t ino, const char *buffer,
                      size_t size, off_t offset, struct fuse_file_info *info) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *node = sfs_acquire(mount, ino);
  if (!node) { fuse_reply_err(req, ESTALE); return; }
  char *path = sfs_path(mount, node);
  int result = path ? mount->ops.write(path, buffer, size, offset, info) : -ENOMEM;
  if (result < 0 || (size_t) result > size) fuse_reply_err(req, result < 0 ? -result : EIO);
  else fuse_reply_write(req, result);
  free(path);
  sfs_drop(mount, node);
}

struct sfs_directory {
  fuse_req_t req;
  char *buffer;
  size_t size, used;
  off_t offset, index;
};

static int sfs_cache_entry(void *data, const char *name,
                            const struct stat *attributes, off_t ignored) {
  struct sfs_listing *listing = data;
  (void) ignored;
  if (listing->error) return 1;
  if (listing->length == listing->capacity) {
    size_t capacity = listing->capacity ? listing->capacity * 2 : 16;
    if (capacity < listing->capacity ||
        capacity > SIZE_MAX / sizeof(*listing->entries)) {
      listing->error = ENOMEM;
      return 1;
    }
    void *entries = realloc(listing->entries, capacity * sizeof(*listing->entries));
    if (!entries) { listing->error = ENOMEM; return 1; }
    listing->entries = entries;
    listing->capacity = capacity;
  }
  char *copy = strdup(name);
  if (!copy) { listing->error = ENOMEM; return 1; }
  listing->entries[listing->length++] = (struct sfs_directory_entry){
    .name = copy, .attributes = attributes ? *attributes : (struct stat){0}
  };
  return 0;
}

static int sfs_fill(void *data, const char *name, const struct stat *attributes, off_t ignored) {
  struct sfs_directory *directory = data;
  (void) ignored;
  directory->index++;
  if (directory->index <= directory->offset) return 0;
  struct stat entry = attributes ? *attributes : (struct stat){0};
  if (!entry.st_ino) entry.st_ino = (ino_t) -1;
  size_t size = fuse_add_direntry(directory->req, directory->buffer + directory->used,
    directory->size - directory->used, name, &entry, directory->index);
  if (size > directory->size - directory->used) return 1;
  directory->used += size;
  return 0;
}

static void sfs_readdir(fuse_req_t req, fuse_ino_t ino, size_t size,
                        off_t offset, struct fuse_file_info *info) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *node = sfs_acquire(mount, ino);
  if (!node) { fuse_reply_err(req, ESTALE); return; }
  pthread_mutex_lock(&mount->namespace);
  pthread_mutex_lock(&mount->mutex);
  struct sfs_handle *handle = node->handles;
  while (handle && (!handle->directory || handle->info.fh != info->fh))
    handle = handle->next;
  if (handle) handle->readers++;
  pthread_mutex_unlock(&mount->mutex);
  char *path = sfs_path(mount, node);
  struct sfs_directory directory = {.req = req, .size = size, .offset = offset};
  directory.buffer = malloc(size ? size : 1);
  int result = !handle ? -EBADF : offset < 0 ? -EINVAL
    : !path || !directory.buffer ? -ENOMEM : 0;
  if (!result && !handle->listing.ready) {
    result = sfs_check_path(mount, node, path);
    if (!result) result = mount->ops.readdir(path, &handle->listing, sfs_cache_entry, 0, info);
    if (!result && handle->listing.error) result = -handle->listing.error;
    if (result) sfs_free_listing(&handle->listing);
    else handle->listing.ready = true;
  }
  if (!result) {
    directory.index = offset;
    for (size_t index = (size_t) offset; index < handle->listing.length; index++) {
      const struct sfs_directory_entry *entry = &handle->listing.entries[index];
      if (sfs_fill(&directory, entry->name, &entry->attributes, 0)) break;
    }
  }
  if (result) fuse_reply_err(req, -result);
  else fuse_reply_buf(req, directory.buffer, directory.used);
  pthread_mutex_lock(&mount->mutex);
  if (handle) {
    handle->readers--;
    pthread_cond_broadcast(&mount->released);
  }
  pthread_mutex_unlock(&mount->mutex);
  free(directory.buffer); free(path);
  pthread_mutex_unlock(&mount->namespace);
  sfs_drop(mount, node);
}

static void sfs_handle_operation(fuse_req_t req, fuse_ino_t ino,
                                 struct fuse_file_info *info, int operation, int data_sync) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *node = sfs_acquire(mount, ino);
  if (!node) { fuse_reply_err(req, ESTALE); return; }
  char *path = sfs_path(mount, node);
  int result = -ENOMEM;
  if (operation == 3 || operation == 4) {
    // Serialize the final metadata snapshot with getattr and other closes.
    pthread_mutex_lock(&mount->namespace);
    result = sfs_close(mount, node, info, operation == 4);
    pthread_mutex_unlock(&mount->namespace);
  } else if (path) {
    if (operation == 0) result = mount->ops.flush(path, info);
    if (operation == 1) result = mount->ops.fsync(path, data_sync, info);
    if (operation == 2) result = mount->ops.fsyncdir(path, data_sync, info);
  }
  fuse_reply_err(req, -result);
  free(path);
  sfs_drop(mount, node);
}
static void sfs_flush(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *info) {
  sfs_handle_operation(req, ino, info, 0, 0);
}
static void sfs_fsync(fuse_req_t req, fuse_ino_t ino, int data_sync, struct fuse_file_info *info) {
  sfs_handle_operation(req, ino, info, 1, data_sync);
}
static void sfs_fsyncdir(fuse_req_t req, fuse_ino_t ino, int data_sync, struct fuse_file_info *info) {
  sfs_handle_operation(req, ino, info, 2, data_sync);
}
static void sfs_release(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *info) {
  sfs_handle_operation(req, ino, info, 3, 0);
}
static void sfs_releasedir(fuse_req_t req, fuse_ino_t ino, struct fuse_file_info *info) {
  sfs_handle_operation(req, ino, info, 4, 0);
}

static void sfs_access(fuse_req_t req, fuse_ino_t ino, int mode) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *node = sfs_acquire(mount, ino);
  if (!node) { fuse_reply_err(req, ESTALE); return; }
  pthread_mutex_lock(&mount->namespace);
  int result;
  char *path = sfs_checked_path(mount, node, &result);
  if (!result) result = mount->ops.access(path, mode);
  fuse_reply_err(req, -result);
  free(path);
  pthread_mutex_unlock(&mount->namespace);
  sfs_drop(mount, node);
}

static void sfs_readlink(fuse_req_t req, fuse_ino_t ino) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *node = sfs_acquire(mount, ino);
  if (!node) { fuse_reply_err(req, ESTALE); return; }
  if (!node->symlink_target) fuse_reply_err(req, EINVAL);
  else fuse_reply_readlink(req, node->symlink_target);
  sfs_drop(mount, node);
}

static void sfs_statfs(fuse_req_t req, fuse_ino_t ino) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *node = sfs_acquire(mount, ino ? ino : FUSE_ROOT_ID);
  if (!node) { fuse_reply_err(req, ESTALE); return; }
  char *path = sfs_path(mount, node);
  struct statvfs attributes = {0};
  int result = !path ? -ENOMEM : mount->ops.statfs
    ? mount->ops.statfs(path, &attributes) : -ENOSYS;
  if (result) fuse_reply_err(req, -result);
  else fuse_reply_statfs(req, &attributes);
  free(path);
  sfs_drop(mount, node);
}

static int sfs_check_path(struct sfs_mount *mount, struct sfs_node *node,
                          const char *path) {
  pthread_mutex_lock(&mount->mutex);
  bool linked = sfs_linked(node);
  pthread_mutex_unlock(&mount->mutex);
  struct stat attributes = {0};
  int result = linked ? mount->ops.getattr(path, &attributes) : -ESTALE;
  pthread_mutex_lock(&mount->mutex);
  if (!result && node->ino != FUSE_ROOT_ID &&
      (!sfs_same_identity(node, &attributes) ||
       (attributes.st_mode & S_IFMT) != (node->attributes.st_mode & S_IFMT)))
    result = -ESTALE;
  if (result == -ENOENT || result == -ENOTDIR || result == -ESTALE)
    sfs_unlink_name(mount, node, node->parent, node->name);
  pthread_mutex_unlock(&mount->mutex);
  return result;
}

static char *sfs_checked_path(struct sfs_mount *mount, struct sfs_node *node,
                              int *result) {
  for (;;) {
    pthread_mutex_lock(&mount->mutex);
    bool aliased = node->aliases != NULL;
    char *path = sfs_path_locked(node);
    pthread_mutex_unlock(&mount->mutex);
    *result = path ? sfs_check_path(mount, node, path) : -ENOMEM;
    if (!aliased || (*result != -ENOENT && *result != -ENOTDIR && *result != -ESTALE))
      return path;
    free(path);
  }
}

static int sfs_update_attributes(struct sfs_mount *mount, struct sfs_node *node,
                                 struct stat *attributes, int valid,
                                 struct fuse_file_info *info, struct stat *current) {
  pthread_mutex_lock(&mount->namespace);
  int path_result;
  char *path = sfs_checked_path(mount, node, &path_result);
  struct sfs_handle *pinned = NULL;
  struct fuse_file_info retained;
  struct fuse_file_info *effective_info = info;
  pthread_mutex_lock(&mount->mutex);
  // setattr normally has no fh for fchmod/fchown/futimens, even on a linked inode.
  if (!effective_info && node->handles) {
    pinned = node->handles;
    pinned->readers++;
    retained = pinned->info;
    effective_info = &retained;
  }
  pthread_mutex_unlock(&mount->mutex);
  int result = !path ? -ENOMEM : !effective_info && path_result
    ? path_result : sfs_stat(mount, node, effective_info, current);
  if (!result && (valid & FUSE_SET_ATTR_SIZE)) {
    struct fuse_file_info *size_info = info ? info : path_result ? effective_info : NULL;
    result = size_info
      ? mount->ops.ftruncate(path, attributes->st_size, size_info)
      : path_result ? path_result : mount->ops.truncate(path, attributes->st_size);
  }
  int metadata_valid = valid &
    (FUSE_SET_ATTR_MODE | FUSE_SET_ATTR_UID | FUSE_SET_ATTR_GID |
     FUSE_SET_ATTR_ATIME | FUSE_SET_ATTR_MTIME);
  struct stat updated = *attributes;
  if (!result && (valid & (FUSE_SET_ATTR_ATIME | FUSE_SET_ATTR_MTIME |
                           FUSE_SET_ATTR_ATIME_NOW | FUSE_SET_ATTR_MTIME_NOW))) {
    struct timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    if (valid & FUSE_SET_ATTR_ATIME_NOW) updated.st_atim = now;
    if (valid & FUSE_SET_ATTR_MTIME_NOW) updated.st_mtim = now;
    if (valid & (FUSE_SET_ATTR_ATIME | FUSE_SET_ATTR_ATIME_NOW))
      metadata_valid |= FUSE_SET_ATTR_ATIME;
    if (valid & (FUSE_SET_ATTR_MTIME | FUSE_SET_ATTR_MTIME_NOW))
      metadata_valid |= FUSE_SET_ATTR_MTIME;
  }
  if (!result && metadata_valid && effective_info && mount->fsetattr) {
    int dispatch_valid = metadata_valid;
    if (path_result) dispatch_valid |= (1U << 30);
    result = mount->fsetattr(path, &updated, dispatch_valid, effective_info);
  } else if (!result && metadata_valid) {
    if (path_result) {
      result = path_result;
    } else {
      if (metadata_valid & FUSE_SET_ATTR_MODE)
        result = mount->ops.chmod(path, updated.st_mode);
      if (!result && (metadata_valid & (FUSE_SET_ATTR_UID | FUSE_SET_ATTR_GID)))
        result = mount->ops.chown(path,
          metadata_valid & FUSE_SET_ATTR_UID ? updated.st_uid : (uid_t) -1,
          metadata_valid & FUSE_SET_ATTR_GID ? updated.st_gid : (gid_t) -1);
      if (!result && (metadata_valid & (FUSE_SET_ATTR_ATIME | FUSE_SET_ATTR_MTIME))) {
        struct timespec times[2] = {current->st_atim, current->st_mtim};
        if (metadata_valid & FUSE_SET_ATTR_ATIME) times[0] = updated.st_atim;
        if (metadata_valid & FUSE_SET_ATTR_MTIME) times[1] = updated.st_mtim;
        result = mount->ops.utimens(path, times);
      }
    }
  }
  if (!result) result = sfs_stat(mount, node, effective_info, current);
  pthread_mutex_lock(&mount->mutex);
  if (pinned) {
    pinned->readers--;
    pthread_cond_broadcast(&mount->released);
  }
  pthread_mutex_unlock(&mount->mutex);
  free(path);
  pthread_mutex_unlock(&mount->namespace);
  return result;
}

static void sfs_setattr(fuse_req_t req, fuse_ino_t ino, struct stat *attributes,
                        int valid, struct fuse_file_info *info) {
  struct sfs_mount *mount = sfs_enter(req);
  struct sfs_node *node = sfs_acquire(mount, ino);
  if (!node) { fuse_reply_err(req, ESTALE); return; }
  struct stat current;
  int result = sfs_update_attributes(mount, node, attributes, valid, info, &current);
  if (result) fuse_reply_err(req, -result);
  else fuse_reply_attr(req, &current, 0);
  sfs_drop(mount, node);
}

static void sfs_init(void *data, struct fuse_conn_info *connection) {
  struct sfs_mount *mount = data;
  sfs_context = (struct fuse_context){.private_data = mount->userdata,
    .uid = getuid(), .gid = getgid(), .pid = getpid()};
  connection->want |= connection->capable &
    (FUSE_CAP_ASYNC_READ | FUSE_CAP_BIG_WRITES | FUSE_CAP_ATOMIC_O_TRUNC);
  if (mount->ops.init) mount->userdata = mount->ops.init(connection);
}

static void sfs_free(struct sfs_mount *mount) {
  struct sfs_node *node = mount->nodes;
  while (node) {
    struct sfs_node *next = node->next;
    struct sfs_handle *handle = node->handles;
    while (handle) {
      struct sfs_handle *next_handle = handle->next;
      sfs_free_listing(&handle->listing);
      free(handle);
      handle = next_handle;
    }
    while (node->aliases) {
      struct sfs_alias *alias = node->aliases;
      node->aliases = alias->next;
      free(alias->name);
      free(alias);
    }
    free(node->name); free(node->symlink_target); free(node);
    node = next;
  }
  pthread_cond_destroy(&mount->released);
  pthread_mutex_destroy(&mount->mutex);
  pthread_mutex_destroy(&mount->namespace);
  free(mount);
}

static struct fuse *sfs_new(struct fuse_chan *channel, struct fuse_args *args,
                            const struct fuse_operations *ops, size_t size, void *userdata) {
  (void) args;
  struct sfs_mount *mount = calloc(1, sizeof(*mount));
  struct sfs_node *root = calloc(1, sizeof(*root));
  if (!mount || !root) { free(mount); free(root); return NULL; }
  root->name = strdup("");
  if (!root->name) { free(mount); free(root); return NULL; }
  root->ino = FUSE_ROOT_ID;
  root->linked = true;
  root->attributes.st_mode = S_IFDIR | 0755;
  mount->nodes = root;
  mount->next_ino = FUSE_ROOT_ID + 1;
  mount->userdata = userdata;
  mount->fsetattr = sfs_pending_fsetattr;
  sfs_pending_fsetattr = NULL;
  memcpy(&mount->ops, ops, size < sizeof(*ops) ? size : sizeof(*ops));
  pthread_mutex_init(&mount->mutex, NULL);
  pthread_mutex_init(&mount->namespace, NULL);
  pthread_cond_init(&mount->released, NULL);
  const struct fuse_lowlevel_ops callbacks = {
    .init = sfs_init, .lookup = sfs_lookup, .forget = sfs_forget,
    .getattr = sfs_getattr, .setattr = sfs_setattr,
    .open = sfs_open, .opendir = sfs_opendir, .create = sfs_create,
    .mkdir = sfs_mkdir, .unlink = sfs_unlink, .rmdir = sfs_rmdir,
    .rename = sfs_rename, .read = sfs_read, .write = sfs_write,
    .readdir = sfs_readdir, .readlink = sfs_readlink,
    .flush = sfs_flush, .fsync = sfs_fsync, .fsyncdir = sfs_fsyncdir,
    .release = sfs_release, .releasedir = sfs_releasedir,
    .access = sfs_access, .statfs = sfs_statfs
  };
  char *argv[] = {(char *) "scriptfs"};
  struct fuse_args lowlevel_args = FUSE_ARGS_INIT(1, argv);
  mount->session = fuse_lowlevel_new(&lowlevel_args, &callbacks, sizeof(callbacks), mount);
  fuse_opt_free_args(&lowlevel_args);
  if (!mount->session) { sfs_free(mount); return NULL; }
  fuse_session_add_chan(mount->session, channel);
  return (struct fuse *) mount;
}

static int sfs_loop(struct fuse *fuse) {
  return fuse_session_loop_mt(((struct sfs_mount *) fuse)->session);
}
static void sfs_destroy(struct fuse *fuse) {
  struct sfs_mount *mount = (struct sfs_mount *) fuse;
  fuse_session_destroy(mount->session);
  sfs_free(mount);
}

#ifndef SCRIPTFS_INODE_TEST
#define fuse_new sfs_new
#define fuse_loop_mt sfs_loop
#define fuse_destroy sfs_destroy
#define fuse_get_context sfs_get_context
#endif
