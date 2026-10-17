/**
 * Public error-shape compatibility: the spec's public surface names
 * `ValidationError` as the structured validation issue shape.
 * The internal name is ValidationIssue; this re-export locks the public name.
 */

export type { ValidationIssue as ValidationError } from "./types.ts";
