/**
 * Google Classroom REST v1 as far as the Classroom tests need it: courses, rosters, coursework and
 * submissions, served a few items a page, with the coursework-ownership rule Google enforces.
 * Every item also carries fields the gatekeeper does not read, which it must drop.
 */

type Item = Record<string, unknown>;

/** Google's error body for a status, with Classroom's `@Code` message prefix when given. */
export function googleError(code: number, status: string, classroomCode?: string): Response {
  let message = classroomCode ? `@${classroomCode} Request refused for student Alice.` : "Refused.";
  return Response.json({ error: { code, status, message } }, { status: code });
}

/** One request the fake served: its method, path, query and JSON body. */
export type ServedRequest = { method: string; path: string; query: URLSearchParams; body?: Item };

export class FakeClassroom {
  /** How many items each page holds, smaller than any `pageSize` the client asks for. */
  pageSize = 2;
  courses: Item[] = [{
    id: "101", name: "Biology", section: "Period 2", courseState: "ACTIVE",
    alternateLink: "https://classroom.google.com/c/MTAx", ownerId: "1001", enrollmentCode: "abc123",
  }];
  teachers: Item[] = [member("1001", "Ms Teacher")];
  students: Item[] = [
    member("2001", "Alice"), member("2002", "Bob"), member("2003", "Carol"), member("2004", "Dan"),
    member("2005", "Eve"),
  ];
  courseWork: Item[] = [
    courseWork("201", "Lab report", true),
    courseWork("202", "Teacher-made quiz", false),
    courseWork("203", "Essay", true, { state: "DRAFT" }),
  ];
  submissions: Item[] = [
    submission("Cg4Isub1", "201", "2001"),
    submission("Cg4Isub2", "201", "2002"),
    submission("Cg4Isub3", "201", "2003"),
    submission("Cg4Isub9", "202", "2001"),
  ];
  /** Responses served, in order, before the fake answers normally. */
  failures: Response[] = [];
  /** Answers a request in place of the fake, when it returns a response. */
  intercept?: (request: ServedRequest) => Response | undefined;
  requests: ServedRequest[] = [];
  #nextId = 500;

  /** A `fetch` serving this fake, for `vi.stubGlobal("fetch", ...)`. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let request = new Request(input, init);
    let url = new URL(request.url);
    if (url.origin !== "https://classroom.googleapis.com" || !url.pathname.startsWith("/v1/")) {
      throw new Error(`Unexpected request to ${url.origin}${url.pathname}`);
    }
    let text = await request.text();
    let served: ServedRequest = {
      method: request.method, path: url.pathname.slice("/v1".length), query: url.searchParams,
      ...(text ? { body: JSON.parse(text) as Item } : {}),
    };
    this.requests.push(served);
    return this.failures.shift() ?? this.intercept?.(served) ?? this.#serve(served);
  };

  #serve({ method, path, query, body }: ServedRequest): Response {
    let parts = path.split("/").slice(1);
    if (parts.length === 1 && method === "GET") return this.#page(this.courses, query, "courses");

    let course = this.courses.find(({ id }) => id === parts[1]);
    if (!course) return googleError(404, "NOT_FOUND");
    if (parts.length === 2) return Response.json(course);

    if (parts[2] === "teachers" && parts[3] === "me") {
      return this.teachers.some(({ userId }) => userId === "1001")
        ? Response.json(this.teachers[0]) : googleError(403, "PERMISSION_DENIED");
    }
    if (parts[2] === "teachers" || parts[2] === "students") {
      return this.#page(parts[2] === "teachers" ? this.teachers : this.students, query, parts[2]);
    }
    if (parts[2] !== "courseWork") return googleError(404, "NOT_FOUND");

    if (parts.length === 3 && method === "POST") {
      let created = courseWork(String(this.#nextId++), String(body!.title), true, body);
      this.courseWork.push(created);
      return Response.json(created);
    }
    if (parts.length === 3) {
      let states = query.getAll("courseWorkStates");
      return this.#page(this.courseWork.filter(({ state }) => states.includes(String(state))), query,
        "courseWork");
    }

    let work = this.courseWork.find(({ id }) => id === parts[3]);
    if (!work) return googleError(404, "NOT_FOUND");
    if (parts.length === 4) return Response.json(work);

    if (parts.length === 5) {
      let userId = query.get("userId");
      return this.#page(this.submissions.filter(sub => sub.courseWorkId === work.id &&
        (userId === null || sub.userId === userId)), query, "studentSubmissions");
    }

    let [submissionId, verb] = parts[5].split(":");
    let found = this.submissions.find(({ id, courseWorkId }) =>
      id === submissionId && courseWorkId === work.id);
    if (!found) return googleError(404, "NOT_FOUND");
    if (method === "GET") return Response.json(found);
    // Only the project that created the coursework may change its submissions.
    if (work.associatedWithDeveloper !== true) {
      return googleError(403, "PERMISSION_DENIED", "ProjectPermissionDenied");
    }
    if (method === "PATCH") {
      if (query.get("updateMask") !== "assignedGrade") return googleError(400, "INVALID_ARGUMENT");
      found.assignedGrade = body!.assignedGrade;
      return Response.json(found);
    }
    if (method === "POST" && verb === "return") {
      found.state = "RETURNED";
      return Response.json({});
    }
    return googleError(400, "INVALID_ARGUMENT");
  }

  #page(items: Item[], query: URLSearchParams, key: string): Response {
    let start = Number(query.get("pageToken") ?? "0");
    let end = start + this.pageSize;
    return Response.json({
      [key]: items.slice(start, end),
      ...(end < items.length ? { nextPageToken: String(end) } : {}),
    });
  }
}

function member(userId: string, fullName: string): Item {
  return {
    courseId: "101", userId,
    profile: { id: userId, name: { givenName: fullName, fullName }, emailAddress: `${userId}@school.example` },
  };
}

function courseWork(id: string, title: string, owned: boolean, extra: Item = {}): Item {
  return {
    courseId: "101", id, title, state: "PUBLISHED", maxPoints: 100, workType: "ASSIGNMENT",
    creatorUserId: "1001", updateTime: "2026-10-20T12:00:00Z", ...extra,
    associatedWithDeveloper: owned,
  };
}

function submission(id: string, courseWorkId: string, userId: string): Item {
  return {
    courseId: "101", courseWorkId, id, userId, state: "TURNED_IN", draftGrade: 80,
    submissionHistory: [{ stateHistory: { state: "CREATED" } }],
    associatedWithDeveloper: courseWorkId !== "202",
  };
}
