import { mountBoard, type BoardApi, type BoardOptions } from "@gadgets/bundled-blueprints/libraries/teacher-board/client";

declare const gadget: BoardApi;

const options: BoardOptions = {
  "title": "Assignment Companion",
  "eyebrow": "Class preparation \u00b7 Google Classroom",
  "description": "A focused view of your connected course\u2019s app-created coursework, with room to plan what comes next.",
  "connector": "Google Classroom",
  "setup": "Use the connection picker to connect CLASSROOM to a course you teach. This teacher-only board lists published and draft coursework created through this Google connection, not assignments created in Classroom\u2019s own UI or another app. The connector does not provide due dates. No roster, submissions or grades are requested. Reconnect in Workshop if access is revoked. Share a clean blueprint rather than a workspace containing teacher records.",
  "inputLabel": "",
  "inputType": "none",
  "inputValue": "",
  "empty": "No app-created coursework loaded. Refresh your connected course; assignments created directly in Classroom will not appear here.",
  "sample": {
    "title": "Northfield \u00b7 Science 6",
    "subtitle": "Fictional example \u00b7 coursework created through this connection",
    "refreshedAt": "2026-11-04T12:00:00Z",
    "cards": [
      {
        "id": "example-1",
        "title": "Ecosystem field journal",
        "label": "Published",
        "detail": "Observe a local habitat and explain one relationship between living things."
      },
      {
        "id": "example-2",
        "title": "Design a fair test",
        "label": "Teacher draft",
        "detail": "Plan a simple investigation. Prepare the materials before publishing."
      }
    ]
  }
};
mountBoard(gadget, options);
