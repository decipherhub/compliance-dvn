// Placeholder for Phase 7 (delivery tracker). Allows worker/cli.ts to resolve
// its module graph now; Phase 7 overwrites this with the real implementation.
export async function trace(_txHash: string): Promise<any> {
  throw new Error('not implemented')
}
