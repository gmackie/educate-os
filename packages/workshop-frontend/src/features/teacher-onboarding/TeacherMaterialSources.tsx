/** Source-specific steps using the composer's existing uploads and scoped connections. */
export const TeacherMaterialSources = () => (
  <section aria-labelledby="teaching-sources-heading" className="flex flex-col gap-4">
    <h3 id="teaching-sources-heading" className="font-medium text-kumo-default">Choose any of these sources</h3>
    <div className="flex flex-col gap-4 rounded-xl border border-kumo-line bg-kumo-base p-4 text-sm">
      <div className="flex flex-col gap-1">
        <h4 className="font-medium text-kumo-default">Lesson documents and slides</h4>
        <p className="text-kumo-subtle">Choose Attach files for PDF, Word (.docx) or PowerPoint (.pptx). Word body text and slide text can be read; images, layout and speaker notes may be missing. Scans and older Office files need a readable text or PDF export.</p>
      </div>
      <div className="flex flex-col gap-1">
        <h4 className="font-medium text-kumo-default">Google Drive and Classroom</h4>
        <p className="text-kumo-subtle">Choose Add connection, then Google. For Drive, select one file or folder with read-only access to read Docs, Sheets, Slides or PDFs. For Classroom, select a course you teach to read existing coursework instructions and material links. Connect linked Drive files separately to read their contents.</p>
        <p className="text-kumo-subtle">Classroom sources cover coursework and its attachments; standalone Classwork materials are not included. You can share their Drive files directly. If Google is unavailable or your school blocks access, download a supported file or paste the lesson text.</p>
      </div>
      <div className="flex flex-col gap-1">
        <h4 className="font-medium text-kumo-default">LMS course exports</h4>
        <p className="text-kumo-subtle">Export Common Cartridge 1.1–1.3 (.imscc) from your LMS, then choose Attach files. A ZIP must contain that format. The conversation can preview the course outline, readable pages, links, discussions and supported quizzes, and report anything skipped or shortened. Large courses may need a smaller lesson export.</p>
        <p className="text-kumo-subtle">This prepares source material in your personal workspace. Creating school modules uses the school’s separate preview and confirmation flow. Vendor backups such as Moodle .mbz need a Common Cartridge or readable text export.</p>
      </div>
    </div>
    <p className="text-sm text-kumo-subtle">You can combine sources. Originals are kept. Limits: 5 files, 4 MiB each and 5 MiB total per message. Send the brief when you’re ready for AI to read the sources; ask it to show coverage and options before building.</p>
  </section>
);
