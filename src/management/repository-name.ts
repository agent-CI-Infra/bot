// GitHub repository full names are case-insensitive, while repository ids are exact. Tool arguments may spell a full name
// in any case (people and models both do), so compare names after normalization and never normalize an id.
export function sameRepositoryName(fullName: unknown, selected: unknown): boolean {
  return typeof selected === 'string' && typeof fullName === 'string' && selected.toLowerCase() === fullName.toLowerCase();
}
