// The reviewed framework catalog. Each entry's licensing decision, with the quotes and URLs it
// rests on, is recorded in docs/schoolos/standards-licensing.md; change the two together.
import { SchoolOsError } from "@schoolos/contracts";
import type { FrameworkDefinition } from "@schoolos/registry";
import { CatalogEntry, type CaseSource, type CoverageRow, type FrameworkLicense } from "./entry.ts";
import { PLAYTREK_SEED_COMMIT, PLAYTREK_SEED_PATH } from "./playtrek/mapping.ts";
import { C3_SOURCE, CCSS_PUBLISHER_REFERENCE } from "./publisher/mapping.ts";
import { CatalogKey, type CatalogSubject, GRADE_BANDS, type GradeBand } from "./vocabulary.ts";

/** The version of the catalog's own content. A change to any entry or seed is a new version. */
export const CATALOG_VERSION = "1.1.0";
/** When this catalog version was reviewed. */
export const CATALOG_RELEASED_AT = "2026-10-21T00:00:00Z";

const REVIEWED_ON = "2026-10-20";

/**
 * Catalog metadata for a framework. The identifier is the version 5 UUID of the URI in the
 * catalog's namespace (`catalogUuid`); a test keeps the two in step.
 */
function definition(
  key: string,
  identifier: string,
  fields: Omit<FrameworkDefinition, "uri" | "identifier" | "lastChangeDateTime" | "provenance" | "language" | "license">,
  license: FrameworkLicense,
): FrameworkDefinition {
  return {
    uri: `urn:schoolos:catalog:${key}`,
    identifier,
    language: "en",
    license: { title: license.name, identifier: `${key}-license`, uri: license.termsUrl },
    lastChangeDateTime: CATALOG_RELEASED_AT,
    ...fields,
    provenance: {
      source: "derived",
      sourceUri: fields.officialSourceUrl ?? license.termsUrl,
      retrievedAt: CATALOG_RELEASED_AT,
      sourceRevision: `schoolos-catalog@${CATALOG_VERSION}`,
    },
  };
}

/** Coverage rows for `subjects`: `states` names a state per band, and `notes` explains any of them. */
function coverage(
  subjects: readonly CatalogSubject[],
  states: Readonly<Record<GradeBand, CoverageRow["state"]>>,
  notes: Partial<Readonly<Record<GradeBand, string>>> = {},
): CoverageRow[] {
  return subjects.flatMap((subject) =>
    GRADE_BANDS.map((band) => ({ subject, band, state: states[band], ...(notes[band] === undefined ? {} : { note: notes[band] }) })));
}

const seed = { transcriber: "PlayTrek", sourcePath: PLAYTREK_SEED_PATH, sourceCommit: PLAYTREK_SEED_COMMIT } as const;
const ccssTranscription = {
  transcriber: "SchoolOS",
  sources: [CCSS_PUBLISHER_REFERENCE.site, ...CCSS_PUBLISHER_REFERENCE.pdfs],
  generator: "packages/schoolos-catalog/scripts/generate-ccss-publisher-rows.ts",
  retrievedOn: CCSS_PUBLISHER_REFERENCE.retrievedOn,
} as const;

const CCSS_LICENSE: FrameworkLicense = {
  name: "Common Core State Standards Public License",
  termsUrl: "https://www.thecorestandards.org/public-license/",
  attribution:
    "© Copyright 2010. National Governors Association Center for Best Practices and Council of Chief State School Officers. All rights reserved.",
  textRedistribution: "permitted",
  verifiedAt: REVIEWED_ON,
};

const CCSS_SOURCE_NOTE =
  "PlayTrek's transcription where it matched the publisher's text, and the publisher's own statement where it did not. A few statements the publisher's page and PDF disagree on are withheld; import the official text to fill them in.";
const CCSS_HIGH_SCHOOL_NOTE =
  "Read from the publisher's pages and matched word for word against its PDF edition. The few statements where the two differ are withheld; import the official text to fill them in.";

const CCSS_MATH_CASE: CaseSource = {
  title: "Common Core State Standards for Math (CASE Network record, served by OpenSALT)",
  serviceBaseUrl: "https://opensalt.net/ims/case/v1p0",
  documentIdentifier: "c6496676-d7cb-11e8-824f-0242ac160002",
  documentUri: "https://casenetwork.imsglobal.org/uri/c6496676-d7cb-11e8-824f-0242ac160002",
  host: "mirror",
  verifiedAt: REVIEWED_ON,
  notes:
    "Creator CCSSO, adoption status Draft. 746 items with K-8 grade levels and 274 high-school items at 09-12; parses as CASE 1.1. CASE Network itself requires an account, so the public copy is OpenSALT's.",
};

const NGSS_LICENSE: FrameworkLicense = {
  name: "NGSS Copyright, Permissions, and Disclaimer",
  termsUrl: "https://www.nextgenscience.org/ngss-trademarks-and-copyright/ngss-trademarks-and-copyright",
  attribution:
    "Next Generation Science Standards is a registered trademark of WestEd. Neither WestEd nor the lead states and partners that developed the Next Generation Science Standards were involved in the production of this product, and do not endorse it.",
  textRedistribution: "not-permitted",
  verifiedAt: REVIEWED_ON,
};

const C3_LICENSE: FrameworkLicense = {
  name: "C3 Framework reproduction notice",
  termsUrl: "https://www.socialstudies.org/sites/default/files/c3/C3-Framework-for-Social-Studies.pdf",
  attribution:
    "National Council for the Social Studies (NCSS), The College, Career, and Civic Life (C3) Framework for Social Studies State Standards: Guidance for Enhancing the Rigor of K-12 Civics, Economics, Geography, and History (Silver Spring, MD: NCSS, 2013).",
  textRedistribution: "permitted",
  // Re-read from the publication's title page when the indicators were transcribed (SCHO-63).
  verifiedAt: "2026-10-21",
};

const CASEL_LICENSE: FrameworkLicense = {
  name: "CASEL Materials License Agreement",
  termsUrl: "https://casel.org/terms/",
  attribution:
    "The CASEL 5 framework is the work of the Collaborative for Academic, Social, and Emotional Learning (CASEL). The indicators listed with it here were written by PlayTrek, not CASEL, and are not endorsed by CASEL.",
  textRedistribution: "not-permitted",
  verifiedAt: REVIEWED_ON,
};

const ELOF_LICENSE: FrameworkLicense = {
  name: "U.S. Government work (17 U.S.C. § 105)",
  termsUrl: "https://www.govinfo.gov/app/details/GOVPUB-HE23_1100-PURL-gpo65456",
  attribution:
    "Paraphrased from the Head Start Early Learning Outcomes Framework: Ages Birth to Five (U.S. Department of Health and Human Services, Office of Head Start, 2015).",
  textRedistribution: "permitted",
  verifiedAt: REVIEWED_ON,
};

const TEKS_LICENSE: FrameworkLicense = {
  name: "Texas Education Agency copyright notice",
  termsUrl: "https://tea.texas.gov/curriculum-and-instruction/instructional-materials/review-and-adoption-process/p2024-qa.pdf",
  attribution: "Texas Essential Knowledge and Skills (TEKS), Texas Education Agency.",
  textRedistribution: "not-permitted",
  verifiedAt: REVIEWED_ON,
};

const MICHIGAN_LICENSE: FrameworkLicense = {
  name: "State of Michigan copyright",
  termsUrl: "https://www.michigan.gov/mde/services/academic-standards/michigan-academic-standards",
  attribution: "Michigan Academic Standards, Michigan Department of Education. Copyright State of Michigan.",
  textRedistribution: "not-permitted",
  verifiedAt: REVIEWED_ON,
};

const TEKS_API = "https://teks-api.texasgateway.org/ims/case/v1p0";
const TEKS_NOTE =
  "TEA's CASE 1.0 service, read through the registry's tea-teks-api adapter (ADR-0011): it turns CFDocument.subject from a string into a list and derives each item's education levels from the grade or course it sits under. Each record's provenance lists what the adapter changed.";
const teks = (title: string, identifier: string): CaseSource => ({
  title,
  serviceBaseUrl: TEKS_API,
  documentIdentifier: identifier,
  documentUri: `${TEKS_API}/CFDocuments/${identifier}`,
  host: "publisher",
  verifiedAt: REVIEWED_ON,
  adapter: "tea-teks-api",
  notes: TEKS_NOTE,
});

const ENTRIES: readonly CatalogEntry[] = [
  {
    key: CatalogKey.parse("ccss-math"),
    framework: definition("ccss-math", "6004c6ac-fdb1-541e-9851-52a3accc46db", {
      title: "Common Core State Standards for Mathematics",
      creator: "National Governors Association Center for Best Practices; Council of Chief State School Officers",
      publisher: "NGA Center and CCSSO",
      frameworkType: "Standards",
      officialSourceUrl: "https://www.thecorestandards.org/Math/",
      subjects: ["Mathematics"],
      jurisdiction: "United States (multi-state)",
      version: "2010",
      notes: "Catalog items are PlayTrek's K-8 transcription, corrected from the publisher's text, and the high-school standards read from the publisher's pages.",
    }, CCSS_LICENSE),
    status: "available",
    license: CCSS_LICENSE,
    caseSources: [CCSS_MATH_CASE],
    subjects: ["mathematics"],
    coverage: coverage(["mathematics"], { "PK": "gap", "K-2": "items", "3-5": "items", "6-8": "items", "9-12": "items" }, {
      "PK": "CCSS begins at kindergarten.",
      "K-2": CCSS_SOURCE_NOTE,
      "3-5": CCSS_SOURCE_NOTE,
      "6-8": CCSS_SOURCE_NOTE,
      "9-12": `The high-school conceptual categories. ${CCSS_HIGH_SCHOOL_NOTE}`,
    }),
    seed,
    transcription: ccssTranscription,
  },
  {
    key: CatalogKey.parse("ccss-ela"),
    framework: definition("ccss-ela", "1b951177-de57-5651-8b51-301e73bb444a", {
      title: "Common Core State Standards for English Language Arts & Literacy in History/Social Studies, Science, and Technical Subjects",
      creator: "National Governors Association Center for Best Practices; Council of Chief State School Officers",
      publisher: "NGA Center and CCSSO",
      frameworkType: "Standards",
      officialSourceUrl: "https://www.thecorestandards.org/ELA-Literacy/",
      subjects: ["English Language Arts & Literacy"],
      jurisdiction: "United States (multi-state)",
      version: "2010",
      notes:
        "Catalog items are PlayTrek's K-8 transcription of the RL, RI, RF, W, SL and L strands, corrected from the publisher's text, and the grade 9-12 standards and the grade 6-12 literacy standards (RH, RST, WHST) read from the publisher's pages.",
    }, CCSS_LICENSE),
    status: "available",
    license: CCSS_LICENSE,
    caseSources: [],
    subjects: ["english-language-arts"],
    coverage: coverage(["english-language-arts"], { "PK": "gap", "K-2": "items", "3-5": "items", "6-8": "items", "9-12": "items" }, {
      "PK": "CCSS begins at kindergarten.",
      "K-2": CCSS_SOURCE_NOTE,
      "3-5": CCSS_SOURCE_NOTE,
      "6-8": `${CCSS_SOURCE_NOTE} The grade 6-8 literacy standards (RH, RST, WHST): ${CCSS_HIGH_SCHOOL_NOTE}`,
      "9-12": `The grade 9-10 and 11-12 standards and the literacy standards (RH, RST, WHST). ${CCSS_HIGH_SCHOOL_NOTE}`,
    }),
    seed,
    transcription: ccssTranscription,
  },
  {
    key: CatalogKey.parse("ngss"),
    framework: definition("ngss", "b0ae9f36-d47f-5e47-ae99-edd0c52aea0f", {
      title: "Next Generation Science Standards",
      creator: "NGSS Lead States",
      publisher: "Achieve, Inc. (development); standards copyright held by the National Academies Press",
      frameworkType: "Standards",
      officialSourceUrl: "https://www.nextgenscience.org/",
      subjects: ["Science"],
      jurisdiction: "United States (multi-state)",
      version: "2013",
      notes: "Metadata only. Districts, schools and teachers may copy and adapt the NGSS; this public catalog is not one of them, so the text is imported by the district.",
    }, NGSS_LICENSE),
    status: "pointer-only",
    license: NGSS_LICENSE,
    caseSources: [{
      title: "Next Generation Science Standards (OpenSALT)",
      serviceBaseUrl: "https://opensalt.net/ims/case/v1p0",
      documentIdentifier: "c608881b-d7cb-11e8-824f-0242ac160002",
      documentUri: "https://opensalt.net/uri/c608881b-d7cb-11e8-824f-0242ac160002",
      host: "mirror",
      verifiedAt: REVIEWED_ON,
      notes: "Creator 'Achieve, Inc. (NGSS)', adoption status Draft, last changed 2018-10-24. 1,037 items covering K-12 (high school as 09-12); parses as CASE 1.1.",
    }],
    subjects: ["science"],
    coverage: coverage(["science"], { "PK": "gap", "K-2": "pointer", "3-5": "pointer", "6-8": "pointer", "9-12": "pointer" }, {
      "PK": "NGSS begins at kindergarten.",
    }),
  },
  {
    key: CatalogKey.parse("c3"),
    framework: definition("c3", "9dc93391-f8f5-5f67-836b-653ec2705d70", {
      title: "College, Career, and Civic Life (C3) Framework for Social Studies State Standards",
      creator: "National Council for the Social Studies",
      publisher: "National Council for the Social Studies",
      frameworkType: "Framework",
      officialSourceUrl: "https://www.socialstudies.org/standards/c3",
      subjects: ["Social Studies"],
      jurisdiction: "United States (multi-state)",
      version: "2013",
      notes:
        "The Dimension 1-4 grade-band indicators, transcribed by SchoolOS from the NCSS publication (which permits free reproduction) and matched word for word against a second reading of it. The companion documents for other disciplines in its appendices are not included.",
    }, C3_LICENSE),
    status: "available",
    license: C3_LICENSE,
    caseSources: [],
    subjects: ["social-studies"],
    coverage: coverage(["social-studies"], { "PK": "gap", "K-2": "items", "3-5": "items", "6-8": "items", "9-12": "items" }, {
      "PK": "C3 begins at kindergarten.",
    }),
    transcription: {
      transcriber: "SchoolOS",
      sources: [C3_SOURCE.pdf],
      generator: "packages/schoolos-catalog/scripts/generate-c3-rows.ts",
      retrievedOn: C3_SOURCE.retrievedOn,
    },
  },
  {
    key: CatalogKey.parse("casel-5"),
    framework: definition("casel-5", "8cbabbc6-84f9-594c-b599-7ca3d6abf356", {
      title: "CASEL 5 social and emotional competencies",
      creator: "Collaborative for Academic, Social, and Emotional Learning (CASEL)",
      publisher: "CASEL",
      frameworkType: "Competencies",
      officialSourceUrl: "https://casel.org/fundamentals-of-sel/what-is-the-casel-framework/",
      subjects: ["Social and Emotional Learning"],
      jurisdiction: "United States",
      notes:
        "CASEL publishes no grade-band indicators. The catalog's items are PlayTrek's own K-8 indicators organized under CASEL's five competencies, shipped as codes, hierarchy and grade bands with their text withheld.",
    }, CASEL_LICENSE),
    status: "available",
    license: CASEL_LICENSE,
    caseSources: [],
    subjects: ["social-emotional-learning"],
    coverage: coverage(["social-emotional-learning"], {
      "PK": "gap",
      "K-2": "items-without-text",
      "3-5": "items-without-text",
      "6-8": "items-without-text",
      "9-12": "gap",
    }, {
      "PK": "PlayTrek has no pre-K SEL indicators.",
      "K-2": "PlayTrek-authored indicators; text withheld under CASEL's terms.",
      "3-5": "PlayTrek-authored indicators; text withheld under CASEL's terms.",
      "6-8": "PlayTrek-authored indicators; text withheld under CASEL's terms.",
      "9-12": "Gap: PlayTrek has no high-school indicators, and CASEL publishes none.",
    }),
    seed,
  },
  {
    key: CatalogKey.parse("head-start-elof"),
    framework: definition("head-start-elof", "7293c8f3-d6e5-5c26-8241-e1ca00ac84ea", {
      title: "Head Start Early Learning Outcomes Framework: Ages Birth to Five",
      creator: "U.S. Department of Health and Human Services, Office of Head Start",
      publisher: "Office of Head Start",
      frameworkType: "Framework",
      officialSourceUrl: "https://headstart.gov/sites/default/files/pdf/elof-ohs-framework.pdf",
      subjects: ["Early Learning"],
      jurisdiction: "United States (federal)",
      version: "2015",
      notes:
        "Catalog items are PlayTrek's paraphrases of the preschool goals in three domains: Literacy, Language and Communication, and Mathematics Development. The other ELOF domains and the infant/toddler goals are not included.",
    }, ELOF_LICENSE),
    status: "available",
    license: ELOF_LICENSE,
    caseSources: [],
    subjects: ["english-language-arts", "mathematics"],
    coverage: coverage(["english-language-arts", "mathematics"], {
      "PK": "items",
      "K-2": "gap",
      "3-5": "gap",
      "6-8": "gap",
      "9-12": "gap",
    }, { "K-2": "ELOF ends at kindergarten entry.", "3-5": "Out of scope.", "6-8": "Out of scope.", "9-12": "Out of scope." }),
    seed,
  },
  {
    key: CatalogKey.parse("teks"),
    framework: definition("teks", "f6dcb6d4-f1cc-5f1d-9be3-bbd89758ea35", {
      title: "Texas Essential Knowledge and Skills",
      creator: "Texas Education Agency",
      publisher: "Texas Education Agency",
      frameworkType: "Standards",
      officialSourceUrl: "https://tea.texas.gov/academics/curriculum-standards/teks-review/texas-essential-knowledge-and-skills",
      subjects: ["English Language Arts and Reading", "Mathematics", "Science", "Social Studies"],
      jurisdiction: "US-TX",
      notes: "A declared pointer to TEA's own CASE service, one CASE document per TEKS chapter.",
    }, TEKS_LICENSE),
    status: "pointer-only",
    license: TEKS_LICENSE,
    caseSources: [
      teks("Chapter 110. English Language Arts and Reading", "c22d9405-c1f7-51e6-9883-b3c807e67e6c"),
      teks("Chapter 111. Mathematics", "bc997e24-7f3b-5df0-a0cd-3a8ac9cf0e2e"),
      teks("Chapter 112. Science", "2ccca18f-b9cf-5710-8e66-13be2b1b71ba"),
      teks("Chapter 113. Social Studies", "a5db260d-f0b9-5315-9adb-6b41f7e18947"),
      teks("Texas Prekindergarten Guidelines 2022", "853625f1-2c29-4d23-bafc-8e835fd4b090"),
    ],
    subjects: ["english-language-arts", "mathematics", "science", "social-studies"],
    coverage: coverage(["english-language-arts", "mathematics", "science", "social-studies"], {
      "PK": "pointer",
      "K-2": "pointer",
      "3-5": "pointer",
      "6-8": "pointer",
      "9-12": "pointer",
    }, {
      "PK": "Texas Prekindergarten Guidelines.",
      "9-12": "TEKS chapters include the high-school courses. TEA publishes no education levels, so an import derives them from course structure; high-school courses name no grade and are read as grades 9-12.",
    }),
  },
  {
    key: CatalogKey.parse("michigan"),
    framework: definition("michigan", "563059cf-7225-5bb3-97ef-3f00936dc83b", {
      title: "Michigan K-12 Academic Standards",
      creator: "Michigan Department of Education",
      publisher: "Michigan Department of Education",
      frameworkType: "Standards",
      officialSourceUrl: "https://www.michigan.gov/mde/services/academic-standards/michigan-academic-standards",
      subjects: ["English Language Arts", "Mathematics", "Science", "Social Studies"],
      jurisdiction: "US-MI",
      notes:
        "A declared pointer. No CASE service run by the Michigan Department of Education was found; the only CASE copy seen (on OpenSALT) is a third party's.",
    }, MICHIGAN_LICENSE),
    status: "pointer-only",
    license: MICHIGAN_LICENSE,
    caseSources: [],
    subjects: ["english-language-arts", "mathematics", "science", "social-studies"],
    coverage: coverage(["english-language-arts", "mathematics", "science", "social-studies"], {
      "PK": "gap",
      "K-2": "gap",
      "3-5": "gap",
      "6-8": "gap",
      "9-12": "gap",
    }, {
      "K-2": "No verified machine-readable source.",
      "3-5": "No verified machine-readable source.",
      "6-8": "No verified machine-readable source.",
      "9-12": "No verified machine-readable source.",
    }),
  },
].map((entry) => CatalogEntry.parse(entry));

/** Every catalog entry, validated. */
export const CATALOG: readonly CatalogEntry[] = ENTRIES;

/**
 * The catalog entry for a key.
 *
 * @throws SchoolOsError `not-found` if the catalog has no such entry.
 */
export function catalogEntry(key: string): CatalogEntry {
  const entry = CATALOG.find((e) => e.key === key);
  if (entry === undefined) throw new SchoolOsError("not-found", `the catalog has no framework ${key}`);
  return entry;
}
