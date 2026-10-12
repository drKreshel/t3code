import { ORGANIZING_ICON_MAX_DATA_URL_LENGTH } from "@t3tools/contracts";

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

export type OrganizingIconImageResult =
  | { readonly ok: true; readonly dataUrl: string }
  | { readonly ok: false; readonly reason: "unsupported" | "too-large" | "unreadable" };

/** Makes a small self-contained image suitable for SQLite and localStorage. */
export async function createOrganizingIconImage(file: File): Promise<OrganizingIconImageResult> {
  if (!IMAGE_TYPES.has(file.type.toLowerCase())) return { ok: false, reason: "unsupported" };
  if (file.size > MAX_SOURCE_BYTES) return { ok: false, reason: "too-large" };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  try {
    if (bitmap.width < 1 || bitmap.height < 1) return { ok: false, reason: "unreadable" };
    const canvas = document.createElement("canvas");
    for (const longestEdge of [96, 72, 48, 32]) {
      const scale = Math.min(1, longestEdge / bitmap.width, longestEdge / bitmap.height);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) return { ok: false, reason: "unreadable" };
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.9, 0.75, 0.6]) {
        const dataUrl = canvas.toDataURL("image/webp", quality);
        if (dataUrl.length <= ORGANIZING_ICON_MAX_DATA_URL_LENGTH) return { ok: true, dataUrl };
      }
    }
    return { ok: false, reason: "too-large" };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    bitmap.close();
  }
}

export function organizingIconImageError(
  reason: Exclude<OrganizingIconImageResult, { ok: true }>["reason"],
): string {
  if (reason === "unsupported") return "Choose a PNG, JPEG, WebP, GIF, or AVIF image.";
  if (reason === "too-large") return "That image is too large to use as an icon.";
  return "T3 Code could not read that image.";
}
