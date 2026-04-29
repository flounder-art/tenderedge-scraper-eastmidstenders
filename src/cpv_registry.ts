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

export function tagTender(tender: any) {
  const text = `${tender.title} ${tender.buyer} ${tender.description}`.toLowerCase();
  tender.is_vegan = /vegan|plant-based|meat-free/.test(text);
  tender.is_la_tagged = /council|authority|borough/.test(text);
  tender.is_em_tagged = /leicester|nottingham|derby|lincoln/.test(text);
  tender.is_social_care_tagged = /social care|care home|domiciliary/.test(text);
  tender.is_lgr_tagged = /local government|reorganisation|lgr/.test(text);
  tender.vertical = tender.is_social_care_tagged && tender.is_la_tagged ? 'la_social_care' : 'other';
  return tender;
}
