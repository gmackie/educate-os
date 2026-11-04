import { mountBoard, type BoardApi, type BoardOptions } from "@gadgets/bundled-blueprints/libraries/teacher-board/client";

declare const gadget: BoardApi;

const options: BoardOptions = {
  "title": "Research Kit",
  "eyebrow": "Lesson research \u00b7 Web Search",
  "description": "Find a strong starting point for your next lesson. Review original sources, then add your own teaching ideas.",
  "connector": "Web Search",
  "setup": "Enable Web Search in Workshop Connectors if your administrator offers it. Then ask the Workshop agent: \u201cBind my Web Search connection to this gadget as WEB_SEARCH.\u201d Refresh after the binding is attached. Web Search is not automatically injected into gadget code, and the blueprint connection picker does not configure singleton bindings. No Context collection is read in this version. Do not put student information in a search query.",
  "inputLabel": "Lesson topic \u00b7 use a few specific keywords",
  "inputType": "search",
  "inputValue": "freshwater ecosystems classroom activities",
  "empty": "Search a lesson topic to build your source board. Results stay separate from your own notes.",
  "sample": {
    "title": "Freshwater ecosystems",
    "subtitle": "Fictional example \u00b7 illustrative sources, not live search results",
    "refreshedAt": "2026-11-04T12:00:00Z",
    "cards": [
      {
        "id": "example-1",
        "title": "Observe a pond habitat",
        "label": "Fictional source excerpt",
        "detail": "A field-journal activity introduces producers, consumers and decomposers."
      },
      {
        "id": "example-2",
        "title": "Compare two water samples",
        "label": "Fictional source excerpt",
        "detail": "Students record observations and discuss what makes a fair comparison."
      }
    ]
  }
};
mountBoard(gadget, options);
