export type Category = 'database' | 'trajectories' | 'knowledge' | 'workspaces' | 'other';
export interface Footprint {
  measured_at: string;
  entries: {kind: Category; label?: string; device: string | null; bytes: number; projects: Record<string, number>}[];
  missing: Category[];
}
export function storageFootprint(database: string, locations: [Category, string, boolean?, string?][]): Promise<Footprint>;
