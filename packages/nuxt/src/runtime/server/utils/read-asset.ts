import { useStorage } from "#imports";

export const ASSET_BASE_NAME = "w2agent";

export async function readAsset(key: string): Promise<string | null> {
  const storage = useStorage(`assets:${ASSET_BASE_NAME}`);
  if (!(await storage.hasItem(key))) return null;
  const raw = await storage.getItemRaw(key);
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf-8");
}
