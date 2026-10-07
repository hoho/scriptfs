/**
 * A module class: ScriptFS constructs it once per configured instance with the
 * module runtime, so settings from the manifest and config are available here.
 */
export default class ComponentInstructions {
  constructor(runtime) {
    this.heading = runtime.settings.heading;
  }
  getattr({ path: name }) {
    if (name.startsWith("components/") && name.endsWith("/AGENTS.md"))
      return { kind: "file", mode: 0o444 };
  }
  readFile({ path: name }) {
    return `# ${this.heading}\n\nGenerated for \`${name}\`.\n`;
  }
}
