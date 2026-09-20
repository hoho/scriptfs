#define FUSE_USE_VERSION 29
#define SCRIPTFS_INODE_TEST
#include <fuse.h>
#include <fuse_lowlevel.h>
#include <fuse_opt.h>
#include <pthread.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <assert.h>
#include <linux/fuse.h>
#include "fuse-inode-backend.h"

static ino_t path_identity = 100;
static mode_t path_mode = S_IFREG | 0644;
static mode_t original_mode = 0644;
static unsigned path_mutations;
static int last_attribute_flags;
static const char *missing_path;
static int path_error, handle_error;
static ino_t handle_identity = 99;
static off_t handle_size = 6;
static nlink_t handle_links = 1;
static unsigned handle_stats, handle_releases;
static int release_error;
static unsigned handle_truncations;
static int truncate_error;
static bool replace_on_truncate;
static const char *link_target = "original";
static int link_error;
static bool replace_link_on_read;

static int path_stat(const char *path, struct stat *attributes) {
  if (path_error) {
    memset(attributes, 0, sizeof(*attributes));
    return path_error;
  }
  if (missing_path && !strcmp(path, missing_path)) return -ENOENT;
  *attributes = (struct stat){
    .st_ino = path_identity, .st_mode = path_mode, .st_size = 2,
    .st_nlink = S_ISDIR(path_mode) ? 2 : 1
  };
  return 0;
}
static int path_readlink(const char *path, char *target, size_t size) {
  (void) path;
  if (link_error) return link_error;
  snprintf(target, size, "%s", link_target);
  if (replace_link_on_read) path_identity++;
  return 0;
}
static int handle_stat(const char *path, struct stat *attributes, struct fuse_file_info *info) {
  (void) path;
  assert(info->fh == 11 || info->fh == 12);
  handle_stats++;
  if (handle_error) return handle_error;
  *attributes = (struct stat){
    .st_ino = handle_identity, .st_mode = S_IFREG | original_mode,
    .st_size = handle_size, .st_nlink = handle_links,
    .st_mtim = {.tv_sec = 2001, .tv_nsec = 123000000}
  };
  return 0;
}
static int truncate_handle(const char *path, off_t size, struct fuse_file_info *info) {
  (void) path;
  assert(info->fh == 11 && (info->flags & O_TRUNC) && size == 0);
  handle_truncations++;
  if (truncate_error) return truncate_error;
  handle_size = size;
  if (replace_on_truncate) handle_identity++;
  return 0;
}
static int release_handle(const char *path, struct fuse_file_info *info) {
  assert(!strcmp(path, "/file"));
  assert(info->fh == 11 || info->fh == 12);
  handle_releases++;
  return release_error;
}

static int change_handle(const char *path, struct stat *attributes, int valid,
                         struct fuse_file_info *info) {
  (void) path;
  assert(info->fh == 11);
  last_attribute_flags = valid;
  if (valid & FUSE_SET_ATTR_MODE) original_mode = attributes->st_mode & 0777;
  return 0;
}

static int change_path(const char *path, mode_t mode) {
  (void) path; (void) mode;
  path_mutations++;
  return 0;
}

static int truncate_path(const char *path, off_t size) {
  (void) path;
  assert(size == 3);
  path_mutations++;
  return 0;
}

int main(void) {
  char directory_buffer[128];
  struct sfs_directory listing = {.buffer=directory_buffer,.size=sizeof(directory_buffer)};
  assert(sfs_fill(&listing,"first",NULL,0)==0);
  struct fuse_dirent *entry=(struct fuse_dirent *)directory_buffer;
  assert(entry->ino!=0 && entry->off==1 && entry->namelen==5);
  struct sfs_directory page={.buffer=directory_buffer,.size=32,.offset=1};
  assert(sfs_fill(&page,"first",NULL,0)==0 && page.used==0);
  assert(sfs_fill(&page,"second",NULL,0)==0 && page.used==32);
  assert(sfs_fill(&page,"third",NULL,0)==1 && page.used==32);
  assert(((struct fuse_dirent *)directory_buffer)->off==2);
  struct sfs_listing snapshot = {0};
  char name[] = "first";
  assert(!sfs_cache_entry(&snapshot, name, NULL, 0));
  assert(!sfs_cache_entry(&snapshot, "second", NULL, 0));
  name[0] = 'X';
  assert(snapshot.length == 2 && !strcmp(snapshot.entries[0].name, "first"));
  page = (struct sfs_directory){.buffer=directory_buffer,.size=32,.offset=1,.index=1};
  assert(!sfs_fill(&page, snapshot.entries[1].name, &snapshot.entries[1].attributes, 0));
  assert(((struct fuse_dirent *)directory_buffer)->off == 2);
  sfs_free_listing(&snapshot);
  assert(!snapshot.entries && !snapshot.length);
  struct sfs_mount *mount = calloc(1, sizeof(*mount));
  struct sfs_node *root = calloc(1, sizeof(*root));
  assert(mount && root);
  root->ino = FUSE_ROOT_ID;
  root->linked = true;
  root->name = strdup("");
  mount->nodes = root;
  mount->next_ino = 2;
  mount->ops.getattr = path_stat;
  mount->ops.readlink = path_readlink;
  mount->ops.fgetattr = handle_stat;
  mount->ops.ftruncate = truncate_handle;
  mount->ops.release = release_handle;
  mount->ops.chmod = change_path;
  mount->ops.truncate = truncate_path;
  mount->fsetattr = change_handle;
  pthread_mutex_init(&mount->mutex, NULL);
  pthread_mutex_init(&mount->namespace, NULL);
  pthread_cond_init(&mount->released, NULL);

  struct stat old = {.st_ino = 99, .st_mode = S_IFREG | 0644, .st_size = 6, .st_nlink = 1};
  struct stat replacement = {.st_ino = 100, .st_mode = S_IFREG | 0644, .st_size = 2, .st_nlink = 1};
  struct sfs_node opening = {.ino = 2, .identity = 99, .attributes = old};
  struct fuse_file_info opening_info = {.fh = 11, .flags = O_WRONLY | O_TRUNC};
  struct stat opened;
  handle_identity = 100;
  assert(sfs_open_attributes(mount, &opening, "/file", &opening_info, false, &opened) == -ESTALE);
  assert(handle_truncations == 0 && handle_size == 6);
  handle_identity = 99;
  handle_error = -EIO;
  assert(sfs_open_attributes(mount, &opening, "/file", &opening_info, false, &opened) == -EIO);
  assert(handle_truncations == 0);
  handle_error = 0;
  opening_info.flags = O_WRONLY;
  assert(!sfs_open_attributes(mount, &opening, "/file", &opening_info, false, &opened));
  assert(handle_truncations == 0 && opened.st_size == 6);
  opening_info.flags |= O_TRUNC;
  assert(!sfs_open_attributes(mount, &opening, "/file", &opening_info, false, &opened));
  assert(handle_truncations == 1 && opened.st_size == 0);
  handle_size = 6;
  truncate_error = -ENOSPC;
  assert(sfs_open_attributes(mount, &opening, "/file", &opening_info, false, &opened) == -ENOSPC);
  assert(handle_truncations == 2 && handle_size == 6);
  truncate_error = 0;
  assert(!sfs_open_attributes(mount, &opening, "/file", &opening_info, true, &opened));
  assert(handle_truncations == 2 && opened.st_size == 6);
  replace_on_truncate = true;
  assert(sfs_open_attributes(mount, &opening, "/file", &opening_info, false, &opened) == -ESTALE);
  assert(handle_truncations == 3);
  replace_on_truncate = false;
  handle_identity = 99;
  handle_size = 6;
  struct sfs_node *first = sfs_register(mount, root, "file", &old, NULL);
  assert(first && first->ino == 2 && first->lookups == 1);
  assert(sfs_register(mount, root, "file", &old, NULL) == first);
  assert(first->lookups == 2);
  struct sfs_handle *handle = calloc(1, sizeof(*handle));
  assert(handle);
  handle->info.fh = 11;
  first->handles = handle;
  struct stat changes = {.st_mode = 0600};
  struct stat result;
  assert(first->linked);
  assert(!sfs_update_attributes(mount, first, &changes, FUSE_SET_ATTR_MODE, NULL, &result));
  assert(original_mode == 0600 && path_mutations == 0);
  assert(last_attribute_flags & (1U << 30));
  assert(!first->linked);
  struct sfs_node *second = sfs_register(mount, root, "file", &replacement, NULL);
  assert(second && second->ino != first->ino);
  assert(!first->linked && second->linked);
  assert(sfs_child(mount, root, "file") == second);
  assert(!sfs_stat(mount, first, NULL, &result));
  assert(result.st_size == 6 && result.st_ino == first->ino);
  handle_error = -ENOENT;
  assert(sfs_stat(mount, first, NULL, &result) == -ENOENT);
  handle_error = 0;
  assert(!sfs_stat(mount, second, NULL, &result));
  assert(result.st_size == 2 && result.st_ino == second->ino);
  fuse_ino_t old_ino = first->ino;
  first->lookups = 0;
  sfs_collect(mount, first);
  assert(sfs_find(mount, old_ino) == first);
  struct fuse_file_info info = {.fh = 11};
  assert(!sfs_close(mount, first, &info, false));
  sfs_collect(mount, first);
  assert(!sfs_find(mount, old_ino));
  assert(sfs_close(mount, second, &info, false) == -EBADF);

  struct sfs_node *stale = sfs_register(mount, root, "stale", &old, NULL);
  assert(sfs_update_attributes(mount, stale, &changes, FUSE_SET_ATTR_MODE, NULL, &result) == -ESTALE);
  assert(path_mutations == 0);
  stale->lookups = 0;
  sfs_collect(mount, stale);

  struct sfs_node *linked = sfs_register(mount, root, "linked", &old, NULL);
  linked->handles = calloc(1, sizeof(*linked->handles));
  assert(linked->handles);
  linked->handles->info.fh = 11;
  path_identity = 99;
  changes.st_size = 3;
  assert(!sfs_update_attributes(mount, linked, &changes, FUSE_SET_ATTR_SIZE, NULL, &result));
  assert(path_mutations == 1);
  assert(!sfs_update_attributes(mount, linked, &changes, FUSE_SET_ATTR_MODE, NULL, &result));
  assert(!(last_attribute_flags & (1U << 30)) && path_mutations == 1);
  free(linked->handles);
  linked->handles = NULL;
  linked->lookups = 0;
  sfs_collect(mount, linked);
  path_identity = 100;

  struct stat directory = {.st_ino = 101, .st_mode = S_IFDIR | 0755, .st_nlink = 2};
  struct sfs_node *guarded = sfs_register(mount, root, "guarded", &directory, NULL);
  path_identity = 101;
  path_mode = S_IFDIR | 0755;
  char *guarded_path = sfs_child_path(mount, guarded, "child");
  assert(guarded_path && !strcmp(guarded_path, "/guarded/child"));
  free(guarded_path);
  path_identity = 102;
  assert(!sfs_child_path(mount, guarded, "child") && errno == ESTALE);
  assert(!guarded->linked);
  guarded->lookups = 0;
  sfs_collect(mount, guarded);
  path_identity = 100;
  path_mode = S_IFREG | 0644;
  struct sfs_node *parent = sfs_register(mount, root, "before", &directory, NULL);
  struct sfs_node *child = sfs_register(mount, parent, "child", &old, NULL);
  assert(parent && child);
  char *path = sfs_path(mount, child);
  assert(!strcmp(path, "/before/child"));
  free(path);
  free(parent->name);
  parent->name = strdup("after");
  path = sfs_path(mount, child);
  assert(!strcmp(path, "/after/child"));
  free(path);
  parent->linked = false;
  assert(!sfs_child_path(mount, child, "new") && errno == ENOENT);
  assert(!sfs_child_path(mount, root, "..") && errno == EINVAL);
  parent->lookups = 0;
  sfs_collect(mount, parent);
  assert(sfs_find(mount, child->parent->ino) == parent);
  child->lookups = 0;
  sfs_collect(mount, child);
  assert(root->children == 1);
  second->lookups = 0;
  sfs_collect(mount, second);
  assert(root->children == 0 && mount->nodes == root);

  struct stat parent_attributes = {.st_ino = 200, .st_mode = S_IFDIR | 0755, .st_nlink = 2};
  struct sfs_node *left = sfs_register(mount, root, "left", &parent_attributes, NULL);
  parent_attributes.st_ino++;
  struct sfs_node *right = sfs_register(mount, root, "right", &parent_attributes, NULL);
  struct stat hardlink = {.st_ino = 300, .st_mode = S_IFREG | 0644, .st_nlink = 2};
  struct sfs_node *shared = sfs_register(mount, left, "first", &hardlink, NULL);
  assert(shared == sfs_register(mount, right, "second", &hardlink, NULL));
  assert(shared == sfs_register(mount, right, "second", &hardlink, NULL));
  assert(shared->lookups == 3 && left->children == 1 && right->children == 1);
  assert(shared->aliases && !shared->aliases->next);
  sfs_unlink_name(mount, shared, left, "first");
  assert(!sfs_child(mount, left, "first"));
  assert(shared == sfs_child(mount, right, "second"));
  assert(shared->parent == right && left->children == 0);
  assert(shared == sfs_register(mount, left, "third", &hardlink, NULL));
  path_identity = hardlink.st_ino;
  missing_path = "/right/second";
  assert(!sfs_stat(mount, shared, NULL, &result));
  assert(result.st_ino == shared->ino && result.st_size == 2);
  int path_result;
  path = sfs_checked_path(mount, shared, &path_result);
  assert(path && !path_result && !strcmp(path, "/left/third"));
  free(path);
  missing_path = NULL;
  assert(!sfs_child(mount, right, "second"));
  assert(right->children == 0 && shared->parent == left && shared->linked);
  assert(shared == sfs_register(mount, right, "fourth", &hardlink, NULL));
  struct stat other = hardlink;
  other.st_dev = 1;
  other.st_nlink = 1;
  struct sfs_node *replaced = sfs_register(mount, left, "third", &other, NULL);
  assert(replaced && replaced != shared && shared->parent == right);
  assert(replaced->identity == shared->identity && replaced->device != shared->device);
  assert(shared == sfs_child(mount, right, "fourth"));
  assert(replaced == sfs_child(mount, left, "third"));
  shared->lookups = 0;
  sfs_collect(mount, shared);
  replaced->lookups = 0;
  sfs_collect(mount, replaced);
  left->lookups = right->lookups = 0;
  sfs_collect(mount, left);
  sfs_collect(mount, right);
  assert(root->children == 0 && mount->nodes == root);

  const mode_t retained_kinds[] = {S_IFREG, S_IFDIR, S_IFLNK};
  const int missing_errors[] = {-ENOENT, -ENOTDIR, -ESTALE};
  for (size_t index = 0; index < sizeof(retained_kinds) / sizeof(*retained_kinds); index++) {
    struct stat cached = {
      .st_ino = 340 + index, .st_mode = retained_kinds[index] | 0755,
      .st_nlink = 1, .st_size = 8
    };
    struct sfs_node *missing = sfs_register(mount, root, "missing", &cached,
      S_ISLNK(cached.st_mode) ? "original" : NULL);
    assert(missing);
    for (size_t error = 0; error < sizeof(missing_errors) / sizeof(*missing_errors); error++) {
      path_error = missing_errors[error];
      assert(!sfs_stat(mount, missing, NULL, &result));
      assert(result.st_ino == missing->ino && result.st_size == cached.st_size);
      assert(result.st_mode == cached.st_mode && result.st_nlink == cached.st_nlink);
      assert(sfs_stat(mount, root, NULL, &result) == path_error);
    }
    path_error = -EACCES;
    assert(sfs_stat(mount, missing, NULL, &result) == -EACCES);
    path_error = -EIO;
    assert(sfs_stat(mount, missing, NULL, &result) == -EIO);
    path_error = 0;
    missing->lookups = 0;
    sfs_collect(mount, missing);
  }
  assert(root->children == 0 && mount->nodes == root);

  struct stat retained_attributes = {
    .st_ino = 350, .st_mode = S_IFREG | 0644, .st_nlink = 2
  };
  struct sfs_node *retained = sfs_register(mount, root, "retained", &retained_attributes, NULL);
  assert(retained == sfs_register(mount, root, "retained-alias", &retained_attributes, NULL));
  sfs_remove_name(mount, retained, root, "retained", NULL);
  assert(retained->attributes.st_nlink == 1 && retained->linked);
  sfs_remove_name(mount, retained, root, "retained-alias", NULL);
  assert(!retained->linked);
  assert(!sfs_stat(mount, retained, NULL, &result));
  assert(result.st_nlink == 0);
  retained->lookups = 0;
  sfs_collect(mount, retained);

  for (unsigned same_name = 0; same_name < 2; same_name++) {
    retained_attributes.st_ino++;
    retained_attributes.st_nlink = 1;
    retained_attributes.st_size = 8;
    retained = sfs_register(mount, root, "recycled", &retained_attributes, NULL);
    sfs_remove_name(mount, retained, root, "recycled", &retained_attributes);
    assert(!retained->linked && retained->attributes.st_nlink == 0);
    retained_attributes.st_size = 3;
    struct sfs_node *recycled = sfs_register(mount, root,
      same_name ? "recycled" : "new-name", &retained_attributes, NULL);
    assert(recycled && recycled != retained && recycled->ino != retained->ino);
    assert(!sfs_stat(mount, retained, NULL, &result));
    assert(result.st_size == 8 && result.st_nlink == 0);
    unsigned mutations = path_mutations;
    assert(sfs_update_attributes(mount, retained, &changes, FUSE_SET_ATTR_MODE,
      NULL, &result) == -ESTALE);
    assert(path_mutations == mutations);
    retained->lookups = recycled->lookups = 0;
    sfs_collect(mount, retained);
    sfs_collect(mount, recycled);
  }

  retained_attributes.st_ino++;
  retained_attributes.st_nlink = 1;
  retained = sfs_register(mount, root, "external-link", &retained_attributes, NULL);
  retained_attributes.st_nlink = 2;
  sfs_remove_name(mount, retained, root, "external-link", &retained_attributes);
  assert(!sfs_stat(mount, retained, NULL, &result));
  assert(result.st_nlink == 1);
  retained_attributes.st_nlink = 1;
  assert(retained == sfs_register(mount, root, "surviving-link", &retained_attributes, NULL));
  assert(retained->linked);
  retained->lookups = 0;
  sfs_collect(mount, retained);

  retained_attributes.st_ino++;
  retained_attributes.st_nlink = 1;
  retained = sfs_register(mount, root, "invalidated", &retained_attributes, NULL);
  sfs_unlink_name(mount, retained, root, "invalidated");
  assert(retained->attributes.st_nlink == 1);
  retained->lookups = 0;
  sfs_collect(mount, retained);

  retained_attributes.st_ino++;
  retained_attributes.st_mode = S_IFDIR | 0755;
  retained_attributes.st_nlink = 2;
  retained = sfs_register(mount, root, "removed-directory", &retained_attributes, NULL);
  sfs_remove_name(mount, retained, root, "removed-directory", NULL);
  assert(!sfs_stat(mount, retained, NULL, &result));
  assert(result.st_nlink == 0);
  retained->lookups = 0;
  sfs_collect(mount, retained);
  assert(root->children == 0 && mount->nodes == root);

  for (unsigned failure = 0; failure < 5; failure++) {
    retained = sfs_register(mount, root, "file", &old, NULL);
    assert(retained);
    sfs_remove_name(mount, retained, root, "file", &old);
    retained->handles = calloc(1, sizeof(*retained->handles));
    assert(retained->handles);
    retained->handles->info = (struct fuse_file_info){.fh = 11, .flags = O_RDWR};
    handle_identity = failure == 4 ? old.st_ino + 1 : old.st_ino;
    handle_size = 29;
    handle_links = 0;
    handle_error = failure == 1 || failure == 3 ? -EIO : 0;
    release_error = failure == 2 || failure == 3 ? -ENOSPC : 0;
    unsigned stats_before = handle_stats, releases_before = handle_releases;
    if (!failure) {
      struct sfs_handle *reader = calloc(1, sizeof(*reader));
      assert(reader);
      reader->info = (struct fuse_file_info){.fh = 12, .flags = O_RDONLY};
      retained->handles->next = reader;
      assert(!sfs_close(mount, retained, &info, false));
      assert(handle_stats == stats_before && handle_releases == ++releases_before);
    }
    struct fuse_file_info final_info = {.fh = failure ? 11 : 12};
    assert(sfs_close(mount, retained, &final_info, false) ==
      (release_error ? release_error : handle_error));
    assert(!retained->handles && handle_stats == stats_before + 1);
    assert(handle_releases == releases_before + 1);
    handle_error = release_error = 0;
    assert(!sfs_stat(mount, retained, NULL, &result));
    assert(result.st_ino == retained->ino && result.st_nlink == 0);
    assert(result.st_size == (failure == 1 || failure == 3 || failure == 4 ? 6 : 29));
    if (!failure || failure == 2) {
      assert((result.st_mode & 0777) == original_mode);
      assert(result.st_mtim.tv_sec == 2001 && result.st_mtim.tv_nsec == 123000000);
    }
    retained->lookups = 0;
    sfs_collect(mount, retained);
  }
  handle_identity = 99;
  handle_size = 6;
  handle_links = 1;
  assert(root->children == 0 && mount->nodes == root);

  path_identity = 400;
  path_mode = S_IFLNK | 0777;
  struct stat link_attributes;
  assert(!path_stat("/link", &link_attributes));
  char target[PATH_MAX + 1] = {0};
  assert(!sfs_read_symlink(mount, "/link", &link_attributes, target, sizeof(target)));
  struct sfs_node *original_link = sfs_register(mount, root, "link", &link_attributes, target);
  assert(original_link && !strcmp(original_link->symlink_target, "original"));
  assert(original_link->attributes.st_size == 8);
  assert(original_link == sfs_register(mount, root, "link", &link_attributes, target));
  link_target = "replacement";
  assert(!sfs_stat(mount, original_link, NULL, &result));
  assert(result.st_size == 8 && S_ISLNK(result.st_mode));
  path_mode = S_IFREG | 0644;
  assert(!sfs_stat(mount, original_link, NULL, &result));
  assert(result.st_size == 8 && S_ISLNK(result.st_mode));
  path_mode = S_IFLNK | 0777;
  path_identity++;
  assert(!path_stat("/link", &link_attributes));
  assert(!sfs_read_symlink(mount, "/link", &link_attributes, target, sizeof(target)));
  struct sfs_node *replacement_link = sfs_register(mount, root, "link", &link_attributes, target);
  assert(replacement_link && replacement_link != original_link);
  assert(replacement_link->attributes.st_size == 11);
  assert(!original_link->linked && !strcmp(original_link->symlink_target, "original"));
  assert(!strcmp(replacement_link->symlink_target, "replacement"));
  struct sfs_node *updated_link = sfs_register(mount, root, "link", &link_attributes, "updated");
  assert(updated_link && updated_link != replacement_link);
  assert(!strcmp(replacement_link->symlink_target, "replacement"));
  assert(!strcmp(updated_link->symlink_target, "updated"));
  link_error = -EIO;
  assert(sfs_read_symlink(mount, "/link", &link_attributes, target, sizeof(target)) == -EIO);
  link_error = 0;
  replace_link_on_read = true;
  assert(sfs_read_symlink(mount, "/link", &link_attributes, target, sizeof(target)) == -ESTALE);
  replace_link_on_read = false;
  original_link->lookups = replacement_link->lookups = 0;
  sfs_collect(mount, original_link);
  sfs_collect(mount, replacement_link);
  updated_link->lookups = 0;
  sfs_collect(mount, updated_link);
  assert(root->children == 0 && mount->nodes == root);
  sfs_free(mount);
  puts("inode backend unit tests passed");
  return 0;
}
