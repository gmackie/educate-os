import { mountBoard, type BoardApi, type BoardOptions } from "@gadgets/bundled-blueprints/libraries/teacher-board/client";

declare const gadget: BoardApi;

const options: BoardOptions = {
  "title": "Week Ahead",
  "eyebrow": "Teacher planning \u00b7 Google Calendar",
  "description": "See the week clearly. Keep your calendar beside a practical checklist for the lessons ahead.",
  "connector": "Google Calendar",
  "setup": "Connect CALENDAR to a calendar you can read using this blueprint\u2019s connection picker. Refresh reads seven days in the calendar\u2019s time zone. No calendar events are changed. Reconnect in Workshop if permission is revoked.",
  "inputLabel": "Start of seven-day window",
  "inputType": "date",
  "inputValue": "",
  "empty": "No events loaded. Choose a start date and refresh your selected calendar.",
  "sample": {
    "title": "Northfield \u00b7 Teaching calendar",
    "subtitle": "Fictional example \u00b7 America/Detroit",
    "refreshedAt": "2026-11-04T12:00:00Z",
    "cards": [
      {
        "id": "example-1",
        "title": "Ecosystems field journal",
        "label": "Monday \u00b7 9:00 AM",
        "detail": "Prepare observation cards and a short outdoor route."
      },
      {
        "id": "example-2",
        "title": "Team planning",
        "label": "Tuesday \u00b7 3:30 PM",
        "detail": "Bring the unit outline and questions for the science team."
      },
      {
        "id": "example-3",
        "title": "Reading celebration",
        "label": "Friday \u00b7 All day",
        "detail": "Choose a short passage to share with the class."
      }
    ]
  }
};
const today = new Date();
options.inputValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
mountBoard(gadget, options);
