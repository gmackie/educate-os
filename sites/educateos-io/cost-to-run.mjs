// The cost-to-run model behind educateos.io/pricing (SCHO-362). It turns the prices and per-person
// activity in public/assets/cost-to-run.json into a monthly Cloudflare bill for each enrollment
// size, and formats the figures that stamp.mjs writes into every data-cost="key" element. The
// method, the raw measurements and a worked example are in docs/educateos/cost-to-run.md.

import {readFileSync} from "node:fs";

export const COST_DATA = JSON.parse(readFileSync(new URL("./public/assets/cost-to-run.json", import.meta.url), "utf8"));

/** Cost of `quantity` units of a metered product: what exceeds `included`, at `perMillion` USD per million. */
const overage = (quantity, {included, perMillion}) => (Math.max(0, quantity - included) / 1e6) * perMillion;

/** The monthly bill, line by line, for a district with `students` enrolled. */
export function monthlyCost(students, data = COST_DATA) {
  const a = Object.fromEntries(Object.entries(data.assumptions).filter(([key]) => !key.startsWith("$")).map(([key, {value}]) => [key, value]));
  const p = data.prices;
  const teachers = Math.ceil(students / a.studentsPerTeacher);
  const guardians = Math.ceil(students * a.guardiansSigningInPerStudent);

  // District app traffic: each request enters the router and reaches the district Worker by service
  // binding (one billed request), then the district's one Durable Object.
  const appRequests = students * a.studentRequestsPerSchoolDay * a.schoolDaysPerMonth
    + teachers * a.teacherRequestsPerSchoolDay * a.schoolDaysPerMonth
    + guardians * a.guardianRequestsPerMonth;
  const workshopRequests = teachers * a.teacherWorkshopRequestsPerSchoolDay * a.schoolDaysPerMonth;
  const requests = appRequests + workshopRequests + a.cronRunsPerMonth;
  const cpuMs = (appRequests + a.cronRunsPerMonth) * a.cpuMsPerRequest + workshopRequests * a.workshopCpuMsPerRequest;
  const objectRequests = requests;
  // The district object is counted as active all month (an upper bound); each teacher's Workshop
  // object is active for their Workshop hours.
  const gbSeconds = a.daysPerMonth * 86_400 * a.durableObjectGb
    + teachers * a.teacherWorkshopActiveHoursPerSchoolDay * 3_600 * a.schoolDaysPerMonth * a.durableObjectGb;
  const sweeps = a.cronRunsPerMonth;
  const rowsRead = appRequests * a.rowsReadPerRequest + students * a.sweepRowsReadPerStudent * sweeps;
  const rowsWritten = appRequests * a.rowsWrittenPerRequest + students * a.sweepRowsWrittenPerStudent * sweeps;
  const storageGb = (students * a.storageMbPerStudent) / 1024;
  const logEvents = requests * a.logEventsPerRequest;

  const lines = {
    base: p.workersBase.usd,
    requests: overage(requests, p.workersRequests),
    cpu: overage(cpuMs, p.workersCpuMs),
    objectRequests: overage(objectRequests, p.durableObjectRequests),
    duration: overage(gbSeconds, p.durableObjectGbSeconds),
    rowsRead: overage(rowsRead, p.sqliteRowsRead),
    rowsWritten: overage(rowsWritten, p.sqliteRowsWritten),
    storage: Math.max(0, storageGb - p.sqliteStorageGb.included) * p.sqliteStorageGb.perGbMonth,
    logs: overage(logEvents, p.workersLogEvents),
  };
  const usage = Object.values(lines).reduce((sum, value) => sum + value, 0);
  const seats = students + teachers + guardians;
  const access = seats <= p.accessSeat.freeUsers ? 0 : seats * p.accessSeat.perUserMonth;
  return {
    students, teachers, guardians, seats,
    quantities: {requests, cpuMs, objectRequests, gbSeconds, rowsRead, rowsWritten, storageGb, logEvents},
    lines, usage, perStudent: usage / students, access, total: usage + access,
  };
}

const whole = new Intl.NumberFormat("en-US", {maximumFractionDigits: 0});
const usd = (value) => {
  if (value === 0) return "$0";
  if (value < 0.1) return `$${value.toFixed(3)}`;
  if (value < 100) return `$${value.toFixed(2)}`;
  return `$${whole.format(Math.round(value))}`;
};

/** Every figure the page can show, by key: `<size>.<field>`, `<size>.line.<line>`, and the inputs. */
export function costFigures(data = COST_DATA) {
  const figures = new Map([["checked", data.checked], ["window", data.measuredWindow]]);
  for (const students of data.sizes) {
    const cost = monthlyCost(students, data);
    for (const key of ["students", "teachers", "guardians", "seats"]) figures.set(`${students}.${key}`, whole.format(cost[key]));
    for (const key of ["usage", "perStudent", "access", "total"]) figures.set(`${students}.${key}`, usd(cost[key]));
    for (const [line, value] of Object.entries(cost.lines)) figures.set(`${students}.line.${line}`, usd(value));
  }
  for (const [key, entry] of Object.entries(data.assumptions)) if (!key.startsWith("$")) figures.set(`a.${key}`, entry.value >= 1000 ? whole.format(entry.value) : String(entry.value));
  return figures;
}
