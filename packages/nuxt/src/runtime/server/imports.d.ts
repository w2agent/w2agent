declare module "#imports" {
  export function useStorage(base?: string): {
    hasItem(key: string): Promise<boolean>;
    getItemRaw(key: string): Promise<unknown>;
  };
}
