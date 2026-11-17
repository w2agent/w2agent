const assets = new Map<string, string>();

export function setAssets(files: Record<string, string>) {
  assets.clear();
  for (const [key, value] of Object.entries(files)) assets.set(key, value);
}

export const storageBases: string[] = [];

export function useStorage(base = "") {
  storageBases.push(base);
  return {
    async hasItem(key: string) {
      return assets.has(key);
    },
    async getItemRaw(key: string) {
      const value = assets.get(key);
      return value === undefined ? null : Buffer.from(value, "utf-8");
    },
  };
}
