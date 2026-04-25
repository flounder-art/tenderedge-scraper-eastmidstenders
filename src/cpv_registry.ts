export const CPV_TAGS: Record<string, string[]> = {
  "72000000": ["IT Services"],
  "48000000": ["Software"],
  "79000000": ["Business Services"],
  "80000000": ["Education"],
  "85000000": ["Health"],
  "30000000": ["Office Supplies"],
  "45000000": ["Construction"]
};

export function mapCpvToTags(cpv: string[]): string[] {
  const tags = new Set<string>();
  cpv.forEach(code => {
    const prefix = code.substring(0, 2) + "000000";
    if (CPV_TAGS[prefix]) {
      CPV_TAGS[prefix].forEach(t => tags.add(t));
    }
  });
  return Array.from(tags);
}
