// ─── Constants ────────────────────────────────────────────

const PEOPLE_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/api_search";
const COMPANY_SEARCH_URL = "https://api.apollo.io/api/v1/mixed_companies/search";
const PEOPLE_ENRICH_URL = "https://api.apollo.io/api/v1/people/match";

export function apiHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
    "X-Api-Key": apiKey,
  };
}

// ─── URL Parser ───────────────────────────────────────────

export function parseApolloUrl(url: string): Record<string, unknown> {
  let queryString = "";
  if (url.includes("#/")) {
    const hashPart = url.split("#/")[1] || "";
    const qIdx = hashPart.indexOf("?");
    queryString = qIdx >= 0 ? hashPart.substring(qIdx + 1) : "";
  } else {
    const qIdx = url.indexOf("?");
    queryString = qIdx >= 0 ? url.substring(qIdx + 1) : "";
  }

  const urlParams = new URLSearchParams(queryString);
  const params: Record<string, unknown> = {};

  const arrayMappings: Record<string, string> = {
    "personTitles[]": "person_titles",
    "personLocations[]": "person_locations",
    "contactEmailStatusV2[]": "contact_email_status_v2",
    "organizationNotIndustryTagIds[]": "organization_not_industry_tag_ids",
    "qOrganizationKeywordTags[]": "q_organization_keyword_tags",
    "includedOrganizationKeywordFields[]": "included_organization_keyword_fields",
    "qNotOrganizationKeywordTags[]": "q_not_organization_keyword_tags",
    "excludedOrganizationKeywordFields[]": "excluded_organization_keyword_fields",
    "organizationLatestFundingStageCd[]": "organization_latest_funding_stage_cd",
    "organizationNumEmployeesRanges[]": "organization_num_employees_ranges",
    "organizationIndustryTagIds[]": "organization_industry_tag_ids",
    "personSeniorities[]": "person_seniorities",
    "personDepartments[]": "person_departments",
    "organizationLocations[]": "organization_locations",
  };

  for (const [urlKey, apiKey] of Object.entries(arrayMappings)) {
    const values = urlParams.getAll(urlKey);
    if (values.length > 0) {
      params[apiKey] = values.map(decodeURIComponent);
    }
  }

  const sortAsc = urlParams.get("sortAscending");
  if (sortAsc !== null) params.sort_ascending = sortAsc === "true";

  const sortBy = urlParams.get("sortByField");
  if (sortBy !== null) params.sort_by_field = decodeURIComponent(sortBy);

  // Revenue range
  const revMin = urlParams.get("revenueRange[min]");
  const revMax = urlParams.get("revenueRange[max]");
  if (revMin || revMax) {
    const range: Record<string, number> = {};
    if (revMin) range.min = parseInt(revMin, 10);
    if (revMax) range.max = parseInt(revMax, 10);
    params.revenue_range = range;
  }

  return params;
}

export function detectSearchType(url: string): "people" | "companies" {
  if (url.includes("/companies") || url.includes("/organizations")) return "companies";
  return "people";
}

// ─── People Search ────────────────────────────────────────

export interface SearchPerson {
  id: string;
  first_name: string;
  last_name_obfuscated: string;
  title: string;
  company: string;
  has_email: boolean;
}

export async function searchPeoplePage(
  apiKey: string,
  searchParams: Record<string, unknown>,
  page: number
): Promise<{ people: SearchPerson[]; totalEntries: number }> {
  const { recommendation_config_id: _, ...rest } = searchParams;
  const body = { ...rest, page, per_page: 100 };

  const resp = await fetch(PEOPLE_SEARCH_URL, {
    method: "POST",
    headers: apiHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Search error ${resp.status}: ${text.substring(0, 300)}`);
  }

  const data = await resp.json();
  const people: SearchPerson[] = (data.people || []).map((p: Record<string, unknown>) => ({
    id: p.id || "",
    first_name: p.first_name || "",
    last_name_obfuscated: p.last_name_obfuscated || p.last_name || "",
    title: p.title || "",
    company: ((p.organization as Record<string, unknown>) || {}).name || "",
    has_email: !!p.has_email,
  }));

  return { people, totalEntries: data.total_entries || 0 };
}

// ─── People Enrichment ───────────────────────────────────

export interface EnrichedPerson {
  first_name: string;
  last_name: string;
  email: string;
  personal_email: string;
  title: string;
  company: string;
  company_domain: string;
  city: string;
  state: string;
  country: string;
  location: string;
  linkedin_url: string;
  website: string;
  employees: string;
  industry: string;
  phone: string;
  seniority: string;
  departments: string;
}

export async function enrichPersonById(
  apiKey: string,
  personId: string
): Promise<{ data: EnrichedPerson | null; rateLimited: boolean }> {
  const resp = await fetch(PEOPLE_ENRICH_URL, {
    method: "POST",
    headers: apiHeaders(apiKey),
    body: JSON.stringify({ id: personId, reveal_personal_emails: true }),
  });

  if (resp.status === 429) {
    return { data: null, rateLimited: true };
  }

  if (!resp.ok) {
    return { data: null, rateLimited: false };
  }

  const result = await resp.json();
  const person = result.person || {};
  const org = person.organization || {};

  const emailAddrs = person.email_addresses || [];
  const personalEmail = emailAddrs.find((e: Record<string, string>) => e.type === "personal")?.email || "";

  const phones = person.phone_numbers || [];
  const phone = phones.find(
    (p: Record<string, string>) => p.type === "work_direct" || p.type === "mobile"
  )?.sanitized_number || "";

  const depts: string[] = person.departments || [];

  return {
    data: {
      first_name: person.first_name || "",
      last_name: person.last_name || "",
      email: person.email || "",
      personal_email: personalEmail,
      title: person.title || "",
      company: org.name || "",
      company_domain: org.primary_domain || org.website_url || "",
      city: person.city || "",
      state: person.state || "",
      country: person.country || "",
      location: [person.city, person.state, person.country].filter(Boolean).join(", "),
      linkedin_url: person.linkedin_url || "",
      website: org.website_url || "",
      employees: String(org.estimated_num_employees || ""),
      industry: org.industry || "",
      phone,
      seniority: person.seniority || "",
      departments: depts.join("; "),
    },
    rateLimited: false,
  };
}

// ─── Company Search ───────────────────────────────────────

export interface CompanyResult {
  name: string;
  domain: string;
  website: string;
  industry: string;
  employees: string;
  revenue: string;
  city: string;
  state: string;
  country: string;
  location: string;
  linkedin_url: string;
  phone: string;
  founded_year: string;
  description: string;
  latest_funding_stage: string;
  keywords: string;
}

export async function searchCompaniesPage(
  apiKey: string,
  searchParams: Record<string, unknown>,
  page: number
): Promise<{ companies: CompanyResult[]; totalEntries: number }> {
  const { recommendation_config_id: _, ...rest } = searchParams;
  const body = { ...rest, page, per_page: 100 };

  const resp = await fetch(COMPANY_SEARCH_URL, {
    method: "POST",
    headers: apiHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Company search error ${resp.status}: ${text.substring(0, 300)}`);
  }

  const data = await resp.json();
  // Apollo returns companies under "accounts" (with data) and "organizations" (empty)
  const accts = data.accounts || [];
  const orgs = data.organizations || [];
  const raw = accts.length > 0 ? accts : orgs;

  const companies: CompanyResult[] = raw.map((c: Record<string, unknown>) => {
    const keywords = (c.keywords as string[]) || [];
    return {
      name: (c.name as string) || "",
      domain: (c.primary_domain as string) || (c.domain as string) || "",
      website: (c.website_url as string) || "",
      industry: (c.industry as string) || "",
      employees: String((c.estimated_num_employees as number) || ""),
      revenue: (c.organization_revenue_printed as string) || (c.annual_revenue_printed as string) || "",
      city: (c.organization_city as string) || (c.city as string) || "",
      state: (c.organization_state as string) || (c.state as string) || "",
      country: (c.organization_country as string) || (c.country as string) || "",
      location: [
        c.organization_city || c.city,
        c.organization_state || c.state,
        c.organization_country || c.country,
      ].filter(Boolean).join(", "),
      linkedin_url: (c.linkedin_url as string) || "",
      phone: (c.phone as string) || "",
      founded_year: String((c.founded_year as number) || ""),
      description: (c.short_description as string) || "",
      latest_funding_stage: (c.latest_funding_stage as string) || "",
      keywords: keywords.join("; "),
    };
  });

  const totalEntries = data.pagination?.total_entries || data.total_entries || 0;
  return { companies, totalEntries };
}

// ─── CSV Generation ──────────────────────────────────────

function esc(val: string): string {
  if (!val) return "";
  if (val.includes(",") || val.includes('"') || val.includes("\n")) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

const PERSON_CSV_HEADERS = [
  "first_name", "last_name", "email", "personal_email", "title",
  "company", "company_domain", "location", "city", "state", "country",
  "linkedin_url", "website", "employees", "industry", "phone",
  "seniority", "departments",
] as const;

const COMPANY_CSV_HEADERS = [
  "name", "domain", "website", "industry", "employees", "revenue",
  "city", "state", "country", "location", "linkedin_url", "phone",
  "founded_year", "description", "latest_funding_stage", "keywords",
] as const;

export function peopleToCSV(people: EnrichedPerson[]): string {
  const rows = people.map((p) =>
    PERSON_CSV_HEADERS.map((h) => esc(p[h])).join(",")
  );
  return [PERSON_CSV_HEADERS.join(","), ...rows].join("\n");
}

export function companiesToCSV(companies: CompanyResult[]): string {
  const rows = companies.map((c) =>
    COMPANY_CSV_HEADERS.map((h) => esc(c[h])).join(",")
  );
  return [COMPANY_CSV_HEADERS.join(","), ...rows].join("\n");
}
