  _op_fsetattr (signal, path, fd, valid, mode, uid, gid, atimeLow, atimeHigh, mtimeLow, mtimeHigh, detached) {
    const changes = {}
    if (valid & 1) changes.mode = mode
    if (valid & 2) changes.uid = uid
    if (valid & 4) changes.gid = gid
    if (valid & 16) changes.atime = new Date((atimeHigh | 0) * 4294967296 + atimeLow)
    if (valid & 32) changes.mtime = new Date((mtimeHigh | 0) * 4294967296 + mtimeLow)
    this.ops.fsetattr(path, fd, changes, detached, err => signal(err))
  }
