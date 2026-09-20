FUSE_METHOD_VOID(fsetattr, 11, 0,
  (const char *path, struct stat *attributes, int valid, struct fuse_file_info *info), {
    l->path = path;
    l->stat = attributes;
    l->flags = valid;
    l->info = info;
  }, {
    napi_create_string_utf8(env, l->path, NAPI_AUTO_LENGTH, &(argv[2]));
    napi_create_uint32(env, l->info->fh, &(argv[3]));
    napi_create_uint32(env, l->flags, &(argv[4]));
    napi_create_uint32(env, l->stat->st_mode, &(argv[5]));
    napi_create_uint32(env, l->stat->st_uid, &(argv[6]));
    napi_create_uint32(env, l->stat->st_gid, &(argv[7]));
    uint64_t atime = timespec_to_uint64(&l->stat->st_atim);
    uint64_t mtime = timespec_to_uint64(&l->stat->st_mtim);
    FUSE_UINT64_TO_INTS_ARGV(atime, 8)
    FUSE_UINT64_TO_INTS_ARGV(mtime, 10)
    napi_get_boolean(env, (l->flags & (1U << 30)) != 0, &(argv[12]));
  })
