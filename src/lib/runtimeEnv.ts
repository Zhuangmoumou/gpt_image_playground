export function readRuntimeEnv(value: string | undefined): string {
  return String.prototype.trim.call(value ?? '')
}

export function readViteEnv(name: string): string {
  const importMetaObject = typeof import.meta === 'object' && import.meta
    ? import.meta as ImportMeta & { env?: Record<string, string | undefined> }
    : undefined
  return readRuntimeEnv(importMetaObject?.env?.[name])
}
