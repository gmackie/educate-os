# Lesson documents in teacher onboarding

An individual teacher can prepare an editable classroom brief at `/ai/teacher-onboarding`, then
attach a lesson through the existing composer. Preparing the brief does not send it to AI. Sending
uses the normal chat upload, workspace and model paths; it does not publish an activity or enroll
students. SCHO-408 introduced the flow; SCHO-412 makes lesson documents readable in its conversation; SCHO-416 adds slides, course previews and existing Google Classroom teaching sources.

The original upload stays in the chat and scratch worktree. Extraction is a model-input projection,
not a conversion of the stored file, a school Content Studio submission or a claim that every part
of the document was imported.

| Source | Model input |
| --- | --- |
| Word `.docx` | Bounded body text, with an explicit notice that images, headers, footers, comments and embedded objects are omitted |
| PDF with native model support | The original PDF through the existing provider bridge |
| PDF without native model support | Bounded extracted text, with a notice that images, layout and unsupported text encodings may be missing |
| Unreadable PDF/DOCX | A reason and a request for a readable excerpt or text export; no invented document contents |
| PowerPoint `.pptx` | Bounded slide text in presentation relationship order, with explicit omissions of images, charts, speaker notes, animations and layout |
| Common Cartridge 1.1–1.3 `.imscc` or a ZIP containing the same format | Read-only course outline, pages, links, discussions and supported QTI quizzes using the existing course planner; package digest and skipped, unplaced, flattened and truncated coverage precede the excerpt |
| Google Drive file or folder | Existing scoped read-only connection; native Docs, Sheets, Slides and PDF reads use the connector's normal access checks |
| Google Classroom course | `listTeachingMaterials()` reads existing coursework instructions and material links in a course the connected account teaches, including work made outside EducateOS; linked Drive files need a separate connection |
| Older `.doc`/`.ppt` files, vendor-specific LMS backups and other binaries | Original workspace file; teachers should export supported documents or Common Cartridge, or paste readable text |

The bounded `@educateos/doc-extract` parser runs without network or storage. Chat extraction accepts
at most 4 MiB input, 2 MiB inflated content, 100 PDF pages or slides and 2,000,000 parser work units. Extracted
text is capped at one tool result (32,768 UTF-16 code units) and labeled as an excerpt when truncated.
The composer retains its existing limits of five attachments, 4 MiB each and 5 MiB total per send.
MIME-less `.docx`, `.pptx`, `.imscc` and `.pdf` uploads use their extension only as a parser hint; the extractor still
checks the document structure. Such a PDF uses text extraction rather than the native PDF bridge.

Course previews additionally cap archives at 200 entries, each 256 KiB, and manifests at 64 KiB,
2,000 elements and depth 32. The replay work budget charges each file read before the shared
planner decodes it, including repeated placements and QTI references. A large course
may therefore need a smaller lesson export even when its upload fits. Links are never fetched by
the parser. No preview creates a school course, enrolls students or publishes modules. A teacher
with school access can use the separate class import preview and confirmation flow.

The onboarding composer offers labeled Attach files and Add connection actions. The latter uses
the existing Google consent/resource picker: prefer one read-only Drive file/folder or one taught
Classroom course. Classroom's new source read records `classroom/course/<id>` even for an empty
listing and verifies each observer teaches that course. Legacy admission checks stay in place.
Grading/submission methods still require app-owned coursework. Lesson onboarding asks for no roster,
student submissions, grades, source-file changes or ongoing sync. Standalone Classroom course materials
are not listed; share their Drive files directly. An unavailable/blocked Google connector needs a file
export or pasted excerpt.

Scans have no OCR path here. Encrypted files, malformed archives, unsupported encodings and inputs
over the extraction caps remain available as originals but may need an unlocked copy, a smaller
section or a readable text export. Extracted source text is labeled as teaching material rather
than instructions to execute. AI proposals still need the teacher's choice before building.

Regression coverage exercises the real extractor in workerd, attachment replay and original-byte
preservation, plus uploaded PDF, DOCX, PPTX and cartridge documents across two RPC-driven turns against a scripted model whose
request body is inspected. A real Google binding with a fake Google service also verifies existing
coursework reaches the model, persists on later turns and issues no writes or student-data reads. Native PDF input is covered alongside the text fallback.
