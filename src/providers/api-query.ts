const SITE_FILTER = /(?:^|\s)site:([^\s]+)\s*$/i;

export type SiteFilterQuery = {
  query: string;
  includeDomain?: string;
};

/**
 * search.ts appends the domain filter to the query text ("query site:domain").
 * Scrapers rank against that text, but JSON API providers must move it into
 * their native domain parameter, where it does not degrade semantic matching.
 */
export function extractSiteFilter(query: string): SiteFilterQuery {
  const match = query.match(SITE_FILTER);
  if (!match || match.index === undefined) return { query };
  return {
    query: query.slice(0, match.index).trimEnd(),
    includeDomain: match[1],
  };
}
