// Study Coach's page. Drawn by the tutor library from lib/persona.ts.
import { mountTutor, type TutorApi } from "@gadgets/bundled-blueprints/libraries/tutor/client";
import { PERSONA } from "./lib/persona.ts";

// The RPC stub to this gadget's Durable Object, which the Workshop's iframe bootstrap defines.
declare const gadget: TutorApi;

mountTutor({ gadget, persona: PERSONA });
