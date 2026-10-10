import * as Schema from "effect/Schema";

import { ProjectIconOverride } from "./project.ts";

/** Small enough for board rows in SQLite and folder layouts in localStorage. */
export const ORGANIZING_ICON_MAX_DATA_URL_LENGTH = 32 * 1024;

export const OrganizingIconImageDataUrl = Schema.String.check(
  Schema.isMaxLength(ORGANIZING_ICON_MAX_DATA_URL_LENGTH),
  Schema.isPattern(
    /^data:image\/(?:avif|gif|jpeg|png|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/,
  ),
);

export const OrganizingIconOverride = Schema.Union([
  ProjectIconOverride,
  Schema.Struct({
    kind: Schema.Literal("image"),
    dataUrl: OrganizingIconImageDataUrl,
  }),
]);
export type OrganizingIconOverride = typeof OrganizingIconOverride.Type;
