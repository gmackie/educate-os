# Lesson documents in teacher onboarding

An individual teacher can prepare an editable classroom brief at `/ai/teacher-onboarding`, then
attach a lesson through the existing composer. Preparing the brief does not send it to AI. Sending
uses the normal chat upload, workspace and model paths; it does not publish an activity or enroll
students. SCHO-408 introduced the flow; SCHO-412 makes lesson documents readable in its conversation.

The original upload stays in the chat and scratch worktree. Extraction is a model-input projection,
not a conversion of the stored file, a school Content Studio submission or a claim that every part
of the document was imported.

| Source | Model input |
| --- | --- |
| Word `.docx` | Bounded body text, with an explicit notice that images, headers, footers, comments and embedded objects are omitted |
| PDF with native model support | The original PDF through the existing provider bridge |
| PDF without native model support | Bounded extracted text, with a notice that images, layout and unsupported text encodings may be missing |
| Unreadable PDF/DOCX | A reason and a request for a readable excerpt or text export; no invented document contents |
| Slides, older `.doc` files and other binaries | Original workspace file under the existing attachment behavior; teachers should paste an excerpt or export readable text |

The bounded `@educateos/doc-extract` parser runs without network or storage. Chat extraction accepts
at most 4 MiB input, 2 MiB inflated content, 100 PDF pages and 2,000,000 parser work units. Extracted
text is capped at one tool result (32,768 UTF-16 code units) and labeled as an excerpt when truncated.
The composer retains its existing limits of five attachments, 4 MiB each and 5 MiB total per send.
MIME-less `.docx` and `.pdf` uploads use their extension only as a parser hint; the extractor still
checks the document structure. Such a PDF uses text extraction rather than the native PDF bridge.

Scans have no OCR path here. Encrypted files, malformed archives, unsupported encodings and inputs
over the extraction caps remain available as originals but may need an unlocked copy, a smaller
section or a readable text export. Extracted source text is labeled as teaching material rather
than instructions to execute. AI proposals still need the teacher's choice before building.

Regression coverage exercises the real extractor in workerd, attachment replay and original-byte
preservation, plus uploaded PDF and DOCX documents across two RPC-driven turns against a scripted model whose
request body is inspected. Native PDF input is covered alongside the text fallback.
