import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
export const NAME: string = pkg.name;
