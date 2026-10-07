import { open } from "node:fs/promises";

export default {
  open(context) {
    console.log(`[source] open ${context.path}`);
    return { openedAt: new Date() };
  },
  async create(attributes, context) {
    const descriptor = await open(context.sourcePath, "wx", attributes.mode);
    await descriptor.close();
    return this.open(context);
  },
  fsync(dataSync, context) {
    console.log(`[source] ${dataSync ? "fdatasync" : "fsync"} ${context.path}`);
  },
  release(context) {
    console.log(
      `[source] release ${context.path} opened at ${context.handle.openedAt.toISOString()}`,
    );
  },
};
