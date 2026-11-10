import AppKit
import Combine
import Foundation
import QuartzCore
import SwiftUI
import UniformTypeIdentifiers

// A desktop-level always-on-top capture window for Moments.
//
// The Host starts this helper as a child process and drives it over JSONL on
// stdin. Every line the window writes to stdout is a command for the Host:
// `ready`, `query`, `load`, `create`, `update`, `trash` and `pin`. The Host
// pushes `notes`, `note`, `status`, `error`, `saved` and `control` events back.
//
// The window has two shapes: a compact card that only captures thoughts, and
// an expanded panel that lists the whole history and searches through it.

private enum Limits {
    static let listNotes = 200
    static let attachmentsPerNote = 8
    static let attachmentBytes = 5 * 1024 * 1024
    static let totalAttachmentBytes = 10 * 1024 * 1024
    static let imageEdge = 1800
}

// MARK: - Host events

struct FloatAttachmentMeta: Identifiable, Equatable {
    let id: String
    var name: String
    var type: String
    var size: Int
}

struct FloatNote: Identifiable, Equatable {
    let id: String
    var content: String
    var createdAt: Double
    var pinned: Bool
    var attachments: [FloatAttachmentMeta]
}

enum HostEvent {
    case notes(notes: [FloatNote], total: Int)
    case draft(FloatDraft)
    case note(FloatNote)
    case status(String)
    case error(String)
    case saved(String)
    case close
    case ignored
}

enum HostEventError: LocalizedError {
    case invalidJSON
    case invalidEvent

    var errorDescription: String? {
        switch self {
        case .invalidJSON:
            return "line is not valid JSON"
        case .invalidEvent:
            return "event must be an object with a string type"
        }
    }
}

enum HostEventParser {
    static func parse(_ line: String) throws -> HostEvent {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data)
        else {
            throw HostEventError.invalidJSON
        }
        guard let dictionary = object as? [String: Any],
              let type = dictionary["type"] as? String
        else {
            throw HostEventError.invalidEvent
        }
        switch type {
        case "notes":
            let rows = parseNotes(dictionary["notes"])
            let total = (dictionary["total"] as? NSNumber)?.intValue ?? rows.count
            return .notes(notes: rows, total: total)
        case "note":
            guard let note = parseNote(dictionary["note"]) else { return .ignored }
            return .note(note)
        case "draft":
            guard let draft = parseDraft(dictionary["draft"]) else { return .ignored }
            return .draft(draft)
        case "status":
            return .status(dictionary["detail"] as? String ?? "")
        case "error":
            return .error(dictionary["detail"] as? String ?? "")
        case "saved":
            return .saved(dictionary["detail"] as? String ?? "")
        case "control":
            return dictionary["detail"] as? String == "close" ? .close : .ignored
        default:
            return .ignored
        }
    }

    static func parseNotes(_ value: Any?) -> [FloatNote] {
        guard let rows = value as? [[String: Any]] else { return [] }
        return rows.compactMap(parseNote)
    }

    /// The draft the Host kept when the last window closed.
    static func parseDraft(_ value: Any?) -> FloatDraft? {
        guard let dictionary = value as? [String: Any] else { return nil }
        let content = dictionary["content"] as? String ?? ""
        let editingId = (dictionary["editingId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let attachments = (dictionary["attachments"] as? [[String: Any]] ?? []).compactMap { row -> DraftAttachment? in
            guard let dataUrl = row["dataUrl"] as? String, !dataUrl.isEmpty else { return nil }
            return DraftAttachment(
                id: row["id"] as? String ?? UUID().uuidString,
                name: row["name"] as? String ?? "image.png",
                type: row["type"] as? String ?? "image/png",
                size: (row["size"] as? NSNumber)?.intValue ?? 0,
                dataUrl: dataUrl
            )
        }
        // Without text or an image there is nothing a restore could send, so
        // an edit state on its own is not a draft.
        if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, attachments.isEmpty {
            return nil
        }
        return FloatDraft(content: content, editingId: editingId, attachments: attachments)
    }

    static func parseNote(_ value: Any?) -> FloatNote? {
        guard let dictionary = value as? [String: Any],
              let id = dictionary["id"] as? String,
              !id.isEmpty
        else {
            return nil
        }
        let attachments = (dictionary["attachments"] as? [[String: Any]] ?? []).map { row in
            FloatAttachmentMeta(
                id: row["id"] as? String ?? UUID().uuidString,
                name: row["name"] as? String ?? "image",
                type: row["type"] as? String ?? "image/png",
                size: row["size"] as? Int ?? 0
            )
        }
        return FloatNote(
            id: id,
            content: dictionary["content"] as? String ?? "",
            createdAt: (dictionary["createdAt"] as? NSNumber)?.doubleValue ?? 0,
            pinned: dictionary["pinned"] as? Bool ?? false,
            attachments: attachments
        )
    }
}

// MARK: - Window commands

/// Write one JSONL command to stdout for the Host to act on.
enum FloatChannel {
    private static let lock = NSLock()

    static func send(_ event: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: event),
              var line = String(data: data, encoding: .utf8) else {
            return
        }
        line.append("\n")
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(Data(line.utf8))
    }
}

// MARK: - Model

struct DraftAttachment: Identifiable, Equatable {
    let id: String
    var name: String
    var type: String
    var size: Int
    var dataUrl: String
}

/// An unfinished thought handed back by the Host when the window reopens.
struct FloatDraft: Equatable {
    var content: String
    var editingId: String?
    var attachments: [DraftAttachment]
}

final class FloatModel: ObservableObject {
    @Published private(set) var notes: [FloatNote] = []
    @Published private(set) var total = 0
    @Published private(set) var isExpanded = false
    @Published private(set) var query = ""
    @Published var content = "" {
        didSet {
            guard oldValue != content else { return }
            scheduleDraftSave()
        }
    }
    @Published private(set) var editingId: String?
    @Published private(set) var attachments: [DraftAttachment] = []
    @Published private(set) var status = "Capture a thought"
    @Published private(set) var errorMessage: String?
    @Published private(set) var isSaving = false
    @Published var isEditorFocused = false

    /// Told by the app when the window changes shape.
    var onShapeChange: ((Bool) -> Void)?

    /// Sends one window command to the Host. The self-test swaps this for a
    /// collector, so a test process never talks to a Host that is not there.
    var onCommand: (([String: Any]) -> Void)?

    /// Hands the draft to the Host. The self-test swaps this for a collector.
    var onDraft: (([String: Any]) -> Void)?

    /// How long typing rests before the draft is written.
    static let draftDebounce: TimeInterval = 3

    /// The live editor, so the toolbar can type into it.
    private weak var editor: NSTextView?

    private var searchTimer: Timer?
    private var saveTimer: Timer?
    private var draftTimer: Timer?
    private var draftDirty = false

    /// Keep a handle on the editor for the toolbar's commands.
    func attachEditor(_ textView: NSTextView) {
        editor = textView
    }

    /// Type text where the caret is.
    func insertText(_ text: String) {
        guard let editor else { return }
        let range = editor.selectedRange()
        editor.insertText(text, replacementRange: range)
        editor.setSelectedRange(NSRange(location: range.location + text.count, length: 0))
        content = editor.string
    }

    /// Wrap the selection in markers, the way the web composer does.
    func wrapSelection(_ marker: String) {
        guard let editor else { return }
        let range = editor.selectedRange()
        let string = editor.string as NSString
        let selected = range.length > 0 ? string.substring(with: range) : "text"
        let replacement = "\(marker)\(selected)\(marker)"
        editor.insertText(replacement, replacementRange: range)
        editor.setSelectedRange(NSRange(location: range.location + marker.count, length: selected.count))
        content = editor.string
    }

    /// Prefix the current line, for bullet and numbered lists.
    func prefixLine(_ prefix: String) {
        guard let editor else { return }
        let string = editor.string as NSString
        let caret = editor.selectedRange().location
        let lineStart = string.lineRange(for: NSRange(location: caret, length: 0)).location
        editor.insertText(prefix, replacementRange: NSRange(location: lineStart, length: 0))
        editor.setSelectedRange(NSRange(location: caret + prefix.count, length: 0))
        content = editor.string
    }

    /// Attach an image from the clipboard, whichever shape it arrives in: a
    /// screenshot, raw image bytes, or a file copied in the Finder. An empty
    /// clipboard opens the file picker instead of dead-ending on an error.
    func pasteImage() {
        guard let payload = ImagePayload.from(NSPasteboard.general) else {
            errorMessage = "The clipboard has no image; choose a file instead"
            chooseImages()
            return
        }
        addImage(data: payload.data, type: payload.type)
        focusEditor()
    }

    /// Ask for image files on disk and attach every one that fits.
    func chooseImages() {
        let panel = NSOpenPanel()
        panel.title = "Attach an image"
        panel.message = "Choose a screenshot or image file for this note"
        panel.prompt = "Attach"
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.image]
        guard panel.runModal() == .OK else { return }
        var problem: String?
        for url in panel.urls {
            if let failure = addImageFile(at: url), problem == nil { problem = failure }
        }
        errorMessage = problem
        focusEditor()
    }

    /// Attach one image file, from the picker, a drop or a copied file.
    @discardableResult
    func addImageFile(at url: URL) -> String? {
        guard let payload = ImagePayload.from(fileAt: url) else {
            return "\(url.lastPathComponent) is not an image Moments can attach"
        }
        return addImage(data: payload.data, type: payload.type, name: url.lastPathComponent)
    }

    /// Take the images out of a Finder or browser drop on the card.
    func acceptDrop(_ providers: [NSItemProvider]) {
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { [weak self] item, _ in
                    var url: URL?
                    if let data = item as? Data { url = URL(dataRepresentation: data, relativeTo: nil) }
                    if let candidate = item as? URL { url = candidate }
                    if let candidate = item as? NSURL { url = candidate as URL }
                    guard let url else { return }
                    DispatchQueue.main.async { [weak self] in
                        guard let self, let problem = self.addImageFile(at: url) else { return }
                        self.errorMessage = problem
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] raw, _ in
                    guard let raw, let png = ImagePayload.pngData(from: raw) else { return }
                    DispatchQueue.main.async { [weak self] in
                        self?.addImage(data: png, type: "image/png")
                    }
                }
            }
        }
    }

    /// Put the caret back in the editor after the picker or a drop took focus.
    func focusEditor() {
        guard let editor, let window = editor.window else { return }
        window.makeFirstResponder(editor)
    }

    /// Applies one Host event. Returns true when the window must close.
    @discardableResult
    func handle(line: String) -> Bool {
        guard !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        do {
            let event = try HostEventParser.parse(line)
            return apply(event)
        } catch {
            errorMessage = "Cannot read the Host message: \(error.localizedDescription)"
            return false
        }
    }

    @discardableResult
    private func apply(_ event: HostEvent) -> Bool {
        switch event {
        case let .notes(notes, total):
            self.notes = notes
            self.total = total
        case let .note(note):
            load(note)
        case let .draft(draft):
            restore(draft)
        case let .status(detail):
            status = detail.isEmpty ? "Capture a thought" : detail
            errorMessage = nil
        case let .error(detail):
            errorMessage = detail.isEmpty ? "The action failed" : detail
        case let .saved(detail):
            saveTimer?.invalidate()
            isSaving = false
            errorMessage = nil
            status = detail.isEmpty ? "Saved" : detail
            clearEditor()
            discardDraft()
            refreshNotes()
        case .close:
            return true
        case .ignored:
            break
        }
        return false
    }

    // MARK: Draft

    /// Send one command to the Host, or to whatever the self-test swapped in.
    private func send(_ event: [String: Any]) {
        (onCommand ?? { FloatChannel.send($0) })(event)
    }

    /// Whether there is anything worth restoring.
    var hasDraftContent: Bool {
        !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !attachments.isEmpty
            || editingId != nil
    }

    /// Mark the draft as changed and write it once typing pauses.
    func scheduleDraftSave() {
        draftDirty = true
        draftTimer?.invalidate()
        draftTimer = Timer.scheduledTimer(withTimeInterval: Self.draftDebounce, repeats: false) { [weak self] _ in
            self?.persistDraft()
        }
    }

    /// Write the draft now, for a closing window that cannot wait three seconds.
    func persistDraft(force: Bool = false) {
        draftTimer?.invalidate()
        draftTimer = nil
        guard draftDirty || force else { return }
        draftDirty = false
        var payload: [String: Any] = ["content": content]
        if let editingId { payload["editingId"] = editingId }
        if !attachments.isEmpty {
            payload["attachments"] = attachments.map {
                ["id": $0.id, "name": $0.name, "type": $0.type, "size": $0.size, "dataUrl": $0.dataUrl]
            }
        }
        (onDraft ?? { FloatChannel.send(["type": "draft", "draft": $0]) })(payload)
    }

    /// Forget the stored draft because the Host already has the note.
    func discardDraft() {
        draftTimer?.invalidate()
        draftTimer = nil
        draftDirty = false
    }

    /// Put back what the last window was writing. Never overwrite a live draft:
    /// if the person already started typing, their words win.
    func restore(_ draft: FloatDraft) {
        guard !hasDraftContent else { return }
        content = draft.content
        attachments = draft.attachments
        editingId = draft.editingId
        status = editingId == nil ? "Draft restored" : "Editing a note — draft restored"
        isEditorFocused = false
        draftTimer?.invalidate()
        draftTimer = nil
        draftDirty = false
        focusEditor()
    }

    // MARK: Shape

    /// Grow into the full panel or fold back into the small card.
    func toggleShape() {
        isExpanded.toggle()
        onShapeChange?(isExpanded)
        if isExpanded { refreshNotes() }
    }

    /// Ask the Host for the notes that match the current search.
    func refreshNotes() {
        send(["type": "query", "query": query])
    }

    /// Search through the whole history.
    func updateQuery(_ text: String) {
        query = text
        searchTimer?.invalidate()
        searchTimer = Timer.scheduledTimer(withTimeInterval: 0.22, repeats: false) { [weak self] _ in
            self?.refreshNotes()
        }
    }

    // MARK: Editing

    var canSave: Bool {
        !isSaving && (!content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
    }

    var isEditing: Bool { editingId != nil }

    func clearEditor() {
        content = ""
        editingId = nil
        attachments = []
    }

    func load(_ note: FloatNote) {
        editingId = note.id
        content = note.content
        attachments = []
        status = "Editing a note"
        scheduleDraftSave()
    }

    func cancelEdit() {
        clearEditor()
        status = "Capture a thought"
        // Dropping an edit drops the stored draft too, otherwise the window
        // would reopen into the note the person just cancelled.
        persistDraft(force: true)
    }

    func save() {
        guard canSave else { return }
        isSaving = true
        errorMessage = nil
        var event: [String: Any] = editingId == nil
            ? ["type": "create", "content": content]
            : ["type": "update", "id": editingId as Any, "content": content]
        if !attachments.isEmpty {
            event["attachments"] = attachments.map {
                ["id": $0.id, "name": $0.name, "type": $0.type, "size": $0.size, "dataUrl": $0.dataUrl]
            }
        }
        send(event)
        status = editingId == nil ? "Saving…" : "Updating…"
        saveTimer?.invalidate()
        saveTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in
            guard let self, self.isSaving else { return }
            self.isSaving = false
            self.errorMessage = "The Host did not answer, so the note was not saved"
        }
    }

    func trash(_ note: FloatNote) {
        send(["type": "trash", "id": note.id])
        status = "Moved to trash"
    }

    func togglePin(_ note: FloatNote) {
        send(["type": "pin", "id": note.id, "pinned": !note.pinned])
    }

    func request(_ note: FloatNote) {
        send(["type": "load", "id": note.id])
    }

    // MARK: Attachments

    /// Attach one image. Returns the reason a limit rejected it, so a batch can
    /// report the first failure; nil means the image is attached.
    @discardableResult
    func addImage(data: Data, type: String, name: String? = nil) -> String? {
        if attachments.count >= Limits.attachmentsPerNote {
            return refuse("A note keeps at most \(Limits.attachmentsPerNote) images")
        }
        if data.count > Limits.attachmentBytes {
            return refuse("Each image must be \(Limits.attachmentBytes / 1024 / 1024) MB or smaller")
        }
        let total = attachments.reduce(0) { $0 + $1.size } + data.count
        if total > Limits.totalAttachmentBytes {
            return refuse("Images in one note must total \(Limits.totalAttachmentBytes / 1024 / 1024) MB or less")
        }
        attachments.append(DraftAttachment(
            id: "float-\(UUID().uuidString)",
            name: name ?? "paste-\(attachments.count + 1).png",
            type: type,
            size: data.count,
            dataUrl: "data:\(type);base64,\(data.base64EncodedString())"
        ))
        errorMessage = nil
        scheduleDraftSave()
        return nil
    }

    private func refuse(_ reason: String) -> String {
        errorMessage = reason
        return reason
    }

    func removeAttachment(_ attachment: DraftAttachment) {
        attachments.removeAll { $0.id == attachment.id }
        scheduleDraftSave()
    }
}

// MARK: - Image helpers

enum ImagePayload {
    static func pngData(from raw: Data) -> Data? {
        guard let image = NSImage(data: raw) else { return nil }
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let edge = max(size.width, size.height)
        let scale = edge > Double(Limits.imageEdge) ? Double(Limits.imageEdge) / edge : 1
        let target = NSSize(width: max(1, (size.width * scale).rounded()), height: max(1, (size.height * scale).rounded()))
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(target.width),
            pixelsHigh: Int(target.height),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            return nil
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        NSColor.white.setFill()
        NSRect(origin: .zero, size: target).fill()
        image.draw(in: NSRect(origin: .zero, size: target), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        return bitmap.representation(using: .png, properties: [:])
    }

    /// Load one image file and normalise it to the same PNG payload the
    /// clipboard path produces, so every source lands in the same shape.
    static func from(fileAt url: URL) -> (data: Data, type: String)? {
        guard url.isFileURL else { return nil }
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        if values?.isRegularFile == false { return nil }
        if let size = values?.fileSize, size > Limits.attachmentBytes { return nil }
        guard let raw = try? Data(contentsOf: url, options: .mappedIfSafe) else { return nil }
        guard raw.count <= Limits.attachmentBytes, let png = pngData(from: raw) else { return nil }
        return (png, "image/png")
    }

    /// Read the first usable image from a pasteboard: image bytes first, then a
    /// file URL, which is what a screenshot copied out of the Finder carries.
    static func from(_ pasteboard: NSPasteboard) -> (data: Data, type: String)? {
        let candidates: [(String, NSPasteboard.PasteboardType)] = [
            ("image/png", .png),
            ("image/jpeg", NSPasteboard.PasteboardType("public.jpeg")),
            ("image/tiff", .tiff),
            ("image/gif", NSPasteboard.PasteboardType("com.compuserve.gif")),
        ]
        for (mime, type) in candidates where pasteboard.types?.contains(type) == true {
            guard let raw = pasteboard.data(forType: type) else { continue }
            if mime == "image/png", let png = pngData(from: raw) { return (png, mime) }
            if let png = pngData(from: raw) { return (png, "image/png") }
        }
        for url in fileURLs(in: pasteboard) {
            if let payload = from(fileAt: url) { return payload }
        }
        return nil
    }

    /// The file URLs a pasteboard carries, without decoding their contents.
    static func fileURLs(in pasteboard: NSPasteboard) -> [URL] {
        if let values = pasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [NSURL], !values.isEmpty {
            return values.map { $0 as URL }
        }
        if let raw = pasteboard.data(forType: .fileURL),
           let url = URL(dataRepresentation: raw, relativeTo: nil) {
            return [url]
        }
        return []
    }
}

// MARK: - Editor

final class CaptureTextView: NSTextView {
    var onPasteImage: ((Data, String) -> Void)?
    var onSubmit: (() -> Void)?

    override func paste(_ sender: Any?) {
        if let payload = ImagePayload.from(NSPasteboard.general) {
            onPasteImage?(payload.data, payload.type)
            return
        }
        super.paste(sender)
    }

    override func doCommand(by selector: Selector) {
        if selector == #selector(insertNewline(_:)), let event = NSApp.currentEvent,
           event.modifierFlags.contains(.command) {
            onSubmit?()
            return
        }
        super.doCommand(by: selector)
    }
}

struct CaptureEditor: NSViewRepresentable {
    @Binding var text: String
    var onReady: (NSTextView) -> Void
    var onFocusChange: (Bool) -> Void
    var onPasteImage: (Data, String) -> Void
    var onSubmit: () -> Void

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        // The capture card carries no scrollbar. A legacy scroller keeps a
        // permanent column on the right that reads as a stray strip on an
        // otherwise empty card, so the scroller is removed outright; the text
        // still scrolls with the wheel and the caret keeps itself in view.
        scroll.hasVerticalScroller = false
        scroll.scrollerStyle = .overlay
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.drawsBackground = false
        let textView = CaptureTextView()
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.font = NSFont.systemFont(ofSize: 13.5)
        textView.textColor = .labelColor
        textView.backgroundColor = .clear
        textView.insertionPointColor = .controlAccentColor
        textView.textContainerInset = NSSize(width: 0, height: 6)
        // The default fragment padding pushes the text away from the caret.
        textView.textContainer?.lineFragmentPadding = 0
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.minSize = NSSize(width: 0, height: 60)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.onPasteImage = onPasteImage
        textView.onSubmit = onSubmit
        scroll.documentView = textView
        onReady(textView)
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? CaptureTextView else { return }
        textView.onPasteImage = onPasteImage
        textView.onSubmit = onSubmit
        if textView.string != text {
            textView.string = text
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        private var parent: CaptureEditor

        init(_ parent: CaptureEditor) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            if parent.text != textView.string {
                parent.text = textView.string
            }
        }

        func textDidBeginEditing(_ notification: Notification) {
            parent.onFocusChange(true)
        }

        func textDidEndEditing(_ notification: Notification) {
            parent.onFocusChange(false)
        }
    }
}

// MARK: - Palette

enum Palette {
    /// The Moments ember: the same accent the web panel uses, in a light and a
    /// dark step, so the desktop float carries the product's identity instead
    /// of a second, unrelated colour.
    static let accent = Color(nsColor: dynamic(light: (181, 64, 42), dark: (228, 100, 74)))
    /// The ink that sits on an accent fill: white on the light ember, the
    /// near-black of the canvas on the dark one.
    static let onAccent = Color(nsColor: dynamic(light: (255, 255, 255), dark: (21, 21, 23)))
    static let surface = Color(nsColor: .windowBackgroundColor)
    static let field = Color(nsColor: .textBackgroundColor)
    static let hairline = Color(nsColor: .separatorColor)
    static let edge = Color(nsColor: .separatorColor).opacity(0.55)
    static let secondary = Color.secondary

    /// A colour that follows the system appearance: the light step in light
    /// mode, the dark step in dark mode.
    private static func dynamic(light: (Int, Int, Int), dark: (Int, Int, Int)) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let step = isDark ? dark : light
            return NSColor(srgbRed: CGFloat(step.0) / 255, green: CGFloat(step.1) / 255, blue: CGFloat(step.2) / 255, alpha: 1)
        }
    }
}

/// The Moments mark.
///
/// One geometry for the whole product: an M whose middle valley carries a
/// single ember dot. The plugin icon and the sidebar entry draw the same
/// shape, so the identity survives every surface. The path is authored on a
/// 64 unit grid and scaled into whatever rect it is given.
struct MomentsMark: Shape {
    func path(in rect: CGRect) -> Path {
        let scale = rect.width / 64
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * scale, y: rect.minY + y * scale)
        }
        var path = Path()
        path.move(to: point(19, 43))
        path.addLine(to: point(19, 21))
        path.addCurve(to: point(24.2, 19.3), control1: point(19, 17.8), control2: point(22.4, 16.5))
        path.addLine(to: point(32, 30.4))
        path.addLine(to: point(39.8, 19.3))
        path.addCurve(to: point(45, 21), control1: point(41.6, 16.5), control2: point(45, 17.8))
        path.addLine(to: point(45, 43))
        return path
    }
}

/// The mark with its ember dot, sized for the float header chip.
struct MomentsMarkView: View {
    var color: Color = Palette.accent
    var size: CGFloat = 26

    var body: some View {
        ZStack(alignment: .topLeading) {
            MomentsMark()
                .stroke(color, style: StrokeStyle(lineWidth: size * 5 / 64, lineCap: .round, lineJoin: .round))
                .frame(width: size, height: size)
            Circle()
                .fill(color)
                .frame(width: size * 6 / 64, height: size * 6 / 64)
                .position(x: size / 2, y: size * 43.5 / 64)
        }
        .frame(width: size, height: size)
    }
}

/// The surface that moves the window.
///
/// Steering the frame from a SwiftUI gesture (`setFrameOrigin` on every
/// `onChanged`) makes the card trail the pointer: the gesture layer coalesces
/// and drops events, so the window arrives late and ends a few points away from
/// where the pointer stopped. This view listens to AppKit's own drag events
/// instead, which arrive one for one, so the card stays exactly under the
/// pointer.
///
/// The view sits **behind** the header content in its ZStack, so the close and
/// shape buttons and the expanded search field keep every one of their clicks.
struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { DragAreaView() }

    func updateNSView(_ nsView: NSView, context: Context) {}

    final class DragAreaView: NSView {
        private var monitor: Any?
        private var grabOrigin: NSPoint?
        private var windowOrigin: NSPoint?

        /// Track the drag from AppKit's own event stream.
        ///
        /// A SwiftUI gesture delivers `onChanged` late and in bursts, so the
        /// frame it sets is always a step or three behind the pointer. The
        /// events a view gets while the button is held are not coalesced, so
        /// every one of them moves the window by exactly the distance the
        /// pointer travelled.
        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            // A lost mouse-up must never leave a second monitor behind.
            endDrag()
            grabOrigin = NSEvent.mouseLocation
            windowOrigin = window.frame.origin
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDragged, .leftMouseUp]) { [weak self] dragged in
                guard let self else { return dragged }
                if dragged.type == .leftMouseUp {
                    self.endDrag()
                    return dragged
                }
                guard let grabOrigin = self.grabOrigin, let windowOrigin = self.windowOrigin,
                      let window = self.window else { return dragged }
                let mouse = NSEvent.mouseLocation
                window.setFrameOrigin(NSPoint(
                    x: windowOrigin.x + (mouse.x - grabOrigin.x),
                    y: windowOrigin.y + (mouse.y - grabOrigin.y)
                ))
                return dragged
            }
        }

        private func endDrag() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            grabOrigin = nil
            windowOrigin = nil
        }

        deinit { endDrag() }

        /// The drag is started explicitly above, never by the window.
        override var mouseDownCanMoveWindow: Bool { false }
    }
}

// MARK: - Views

struct FloatRootView: View {
    @ObservedObject var model: FloatModel
    var onClose: () -> Void

    private var expanded: Bool { model.isExpanded }

    /// True while image files hang over the card.
    @State private var isDropTarget = false

    var body: some View {
        ZStack {
            // The shadow has to stay inside the transparent window, otherwise
            // the system clips it and the card wears a hard grey rectangle.
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Palette.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(Palette.edge, lineWidth: 1)
                )
                .shadow(color: Color.black.opacity(0.20), radius: 8, x: 0, y: 2)
            VStack(spacing: 0) {
                header
                if expanded {
                    Rectangle().fill(Palette.hairline).frame(height: 1)
                    history
                    Rectangle().fill(Palette.hairline).frame(height: 1)
                }
                composer
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .padding(18)
        .frame(minWidth: expanded ? 640 : 340)
        .animation(.easeInOut(duration: 0.22), value: expanded)
        .overlay(dropRing)
        .onDrop(of: [UTType.fileURL, UTType.image], isTargeted: $isDropTarget) { providers in
            model.acceptDrop(providers)
            return true
        }
    }

    /// A thin accent ring while an image hovers the card, so the drop has an
    /// answer before it happens.
    @ViewBuilder
    private var dropRing: some View {
        if isDropTarget {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Palette.accent, lineWidth: 1.5)
                .padding(18)
                .allowsHitTesting(false)
        }
    }

    // MARK: Header

    private var header: some View {
        ZStack {
            // The drag surface sits behind the header, so the search field and
            // both buttons keep their own clicks.
            WindowDragArea()
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Palette.accent.opacity(0.14))
                    .frame(width: 26, height: 26)
                    .overlay(MomentsMarkView())
                    .allowsHitTesting(false)
                Text("Moments")
                    .font(.system(size: 15, weight: .semibold))
                    .allowsHitTesting(false)
                if expanded {
                    Text("\(model.total) notes")
                        .font(.system(size: 11))
                        .foregroundColor(Palette.secondary)
                        .allowsHitTesting(false)
                }
                Spacer(minLength: 8)
                if expanded { searchField }
                iconButton(
                    expanded ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                    label: expanded ? "Fold back to the small float" : "Open the full history"
                ) {
                    model.toggleShape()
                }
                iconButton("xmark", label: "Close the float", action: onClose)
            }
            .padding(.horizontal, 18)
        }
        .frame(height: 52)
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(Palette.secondary)
            TextField(
                "Search notes or #tags",
                text: Binding(get: { model.query }, set: { model.updateQuery($0) })
            )
            .textFieldStyle(.plain)
            .font(.system(size: 12))
            if !model.query.isEmpty {
                Button {
                    model.updateQuery("")
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundColor(Palette.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Palette.field)
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(Palette.hairline, lineWidth: 1)
                )
        )
        .frame(width: 220)
    }

    private func iconButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(Palette.secondary)
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.black.opacity(0.05))
                )
        }
        .buttonStyle(.plain)
        .help(label)
    }

    // MARK: History

    private var history: some View {
        VStack(spacing: 0) {
            if model.notes.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: model.query.isEmpty ? "tray" : "magnifyingglass")
                        .font(.system(size: 20, weight: .light))
                        .foregroundColor(Palette.secondary.opacity(0.7))
                    Text(model.query.isEmpty ? "No notes yet" : "No notes match")
                        .font(.system(size: 12))
                        .foregroundColor(Palette.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(model.notes) { note in
                            noteRow(note)
                            Rectangle().fill(Palette.hairline).frame(height: 1)
                        }
                    }
                }
            }
        }
    }

    private func noteRow(_ note: FloatNote) -> some View {
        NoteRow(note: note, onOpen: { model.request(note) }, onPin: { model.togglePin(note) }, onTrash: { model.trash(note) })
    }

    // MARK: Composer

    private var composer: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                if model.content.isEmpty && !model.isEditorFocused {
                    Text("What's on your mind?")
                        .font(.system(size: 15))
                        .foregroundColor(Palette.secondary.opacity(0.85))
                        .padding(.horizontal, 20)
                        .padding(.vertical, 16)
                        .allowsHitTesting(false)
                }
                CaptureEditor(
                    text: Binding(
                        get: { model.content },
                        set: { model.content = $0 }
                    ),
                    onReady: { model.attachEditor($0) },
                    onFocusChange: { focused in model.isEditorFocused = focused },
                    onPasteImage: { data, type in model.addImage(data: data, type: type) },
                    onSubmit: { model.save() }
                )
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            .frame(
                maxWidth: .infinity,
                minHeight: expanded ? 54 : 120,
                maxHeight: expanded ? 84 : .infinity
            )

            if let problem = model.errorMessage {
                Text(problem)
                    .font(.system(size: 11))
                    .foregroundColor(Color.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 4)
            }

            if !model.attachments.isEmpty { attachmentStrip }

            toolbar
        }
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(model.attachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        if let data = Data(base64Encoded: String(attachment.dataUrl.split(separator: ",").last ?? "")) {
                            if let image = NSImage(data: data) {
                                Image(nsImage: image)
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                                    .frame(width: 40, height: 40)
                                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            }
                        }
                        Button {
                            model.removeAttachment(attachment)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 12))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, 18)
        }
        .frame(height: 50)
    }

    /// The Harness composer tool row: tags, images, formats and send.
    private var toolbar: some View {
        HStack(spacing: 12) {
            textToolButton("#", label: "Insert a tag") { model.insertText("#") }
            imageMenu
            Rectangle().fill(Palette.hairline).frame(width: 1, height: 18)
            formatMenu
            toolButton("list.bullet", label: "Bullet list") { model.prefixLine("- ") }
            toolButton("list.number", label: "Numbered list") { model.prefixLine("1. ") }
            Spacer(minLength: 8)
            if model.isEditing {
                Button("Cancel") { model.cancelEdit() }
                    .buttonStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundColor(Palette.secondary)
            }
            Text("Draft · \(model.content.count)")
                .font(.system(size: 11))
                .foregroundColor(Palette.secondary)
            sendButton
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 14)
    }

    /// The two ways to bring an image in: a file from disk or the clipboard.
    private var imageMenu: some View {
        Menu {
            Button("Choose image…") { model.chooseImages() }
            Button("Paste image") { model.pasteImage() }
        } label: {
            Image(systemName: "photo")
                .font(.system(size: 14))
                .foregroundColor(Palette.secondary)
                .frame(width: 20, height: 22)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Attach an image")
    }

    private var formatMenu: some View {        Menu {
            Button("Bold") { model.wrapSelection("**") }
            Button("Italic") { model.wrapSelection("*") }
            Button("Strikethrough") { model.wrapSelection("~~") }
            Button("Inline code") { model.wrapSelection("`") }
            Divider()
            Button("Heading") { model.prefixLine("## ") }
            Button("Quote") { model.prefixLine("> ") }
            Button("Link") { model.insertText("[](https://)") }
        } label: {
            Image(systemName: "textformat")
                .font(.system(size: 14))
                .foregroundColor(Palette.secondary)
                .frame(width: 20, height: 22)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Text format")
    }

    /// A tool drawn as a character, the way the Harness composer draws its hash.
    private func textToolButton(_ glyph: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(glyph)
                .font(.system(size: 15, weight: .regular))
                .foregroundColor(Palette.secondary)
                .frame(width: 20, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
    }

    private func toolButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 14))
                .foregroundColor(Palette.secondary)
                .frame(width: 20, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
    }

    private var sendButton: some View {
        Button {
            model.save()
        } label: {
            Image(systemName: "paperplane.fill")
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(model.canSave ? Palette.onAccent : Palette.secondary)
                .frame(width: 32, height: 28)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(model.canSave ? Palette.accent : Palette.field)
                )
        }
        .buttonStyle(.plain)
        .disabled(!model.canSave)
        .help(model.isEditing ? "Update the note" : "Save the note")
    }
}

struct NoteRow: View {
    let note: FloatNote
    var onOpen: () -> Void
    var onPin: () -> Void
    var onTrash: () -> Void

    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(note.content.isEmpty ? "Image note" : note.content)
                        .font(.system(size: 12.5))
                        .foregroundColor(Color(nsColor: .labelColor))
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        Text(FloatFormat.date(note.createdAt))
                            .font(.system(size: 10))
                            .foregroundColor(Palette.secondary)
                        if !note.attachments.isEmpty {
                            Text("\(note.attachments.count) images")
                                .font(.system(size: 10))
                                .foregroundColor(Palette.secondary)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button(action: onPin) {
                Image(systemName: note.pinned ? "pin.fill" : "pin")
                    .font(.system(size: 11))
                    .frame(width: 18, height: 18)
            }
            .buttonStyle(.plain)
            .foregroundColor(note.pinned ? Palette.accent : Palette.secondary)
            .help(note.pinned ? "Unpin" : "Pin")

            Button(action: onTrash) {
                Image(systemName: "trash")
                    .font(.system(size: 11))
                    .frame(width: 18, height: 18)
            }
            .buttonStyle(.plain)
            .foregroundColor(Palette.secondary)
            .help("Move to trash")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(hovering ? Palette.accent.opacity(0.06) : Color.clear)
        .onHover { hovering = $0 }
    }
}

enum FloatFormat {
    static func date(_ timestamp: Double) -> String {
        guard timestamp > 0 else { return "" }
        let date = Date(timeIntervalSince1970: timestamp / 1000)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "MM-dd HH:mm"
        return formatter.string(from: date)
    }
}

// MARK: - Application

/// A borderless window still has to accept text input.
final class FloatWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}


final class FloatAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let model = FloatModel()
    private var window: NSWindow?
    private var inputThread: Thread?
    private var signalSources: [DispatchSourceSignal] = []
    private var isTerminating = false

    private static let compactSize = NSSize(width: 400, height: 430)
    private static let expandedSize = NSSize(width: 760, height: 620)

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = FloatWindow(
            contentRect: NSRect(origin: .zero, size: FloatAppDelegate.compactSize),
            styleMask: [.borderless, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Moments"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        // The float stays above ordinary windows, follows every Space and may
        // sit over a full-screen app.
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isMovableByWindowBackground = false
        window.isReleasedWhenClosed = false
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.delegate = self
        let root = FloatRootView(model: model) { [weak self] in self?.requestTermination() }
        window.contentView = NSHostingView(rootView: root)
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window

        model.onShapeChange = { [weak self] expanded in
            self?.resize(expanded: expanded)
        }

        installMainMenu()
        NSApplication.shared.activate(ignoringOtherApps: true)
        installSignalHandlers()
        startReadingStandardInput()
        FloatChannel.send(["type": "ready"])
    }

    /// Grow or shrink the window while keeping its top left corner in place.
    private func resize(expanded: Bool) {
        guard let window else { return }
        let size = expanded ? FloatAppDelegate.expandedSize : FloatAppDelegate.compactSize
        let top = window.frame.maxY
        let origin = NSPoint(x: window.frame.origin.x, y: top - size.height)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.22
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            window.setFrame(NSRect(origin: origin, size: size), display: true)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func windowWillClose(_ notification: Notification) {
        requestTermination()
    }

    func applicationWillTerminate(_ notification: Notification) {
        signalSources.forEach { $0.cancel() }
    }

    private func startReadingStandardInput() {
        let thread = Thread { [weak self] in
            while let line = readLine(strippingNewline: true) {
                var shouldClose = false
                DispatchQueue.main.sync {
                    guard let self, !self.isTerminating else { return }
                    shouldClose = self.model.handle(line: line)
                }
                if shouldClose {
                    DispatchQueue.main.async { self?.requestTermination() }
                    return
                }
            }
            DispatchQueue.main.async { self?.requestTermination() }
        }
        thread.name = "moments-float-jsonl-stdin"
        thread.qualityOfService = .userInitiated
        inputThread = thread
        thread.start()
    }

    /// A menu bar with the edit commands a text field expects.
    ///
    /// A borderless accessory window has no menu of its own, and ⌘V is not a
    /// text-view shortcut — it is the Edit ▸ Paste menu item. Without this menu
    /// a pasted screenshot never reached the editor, which is exactly why the
    /// image button seemed to be the only way in.
    private func installMainMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "Moments")
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Close the float", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Moments", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        mainMenu.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        mainMenu.addItem(editItem)

        NSApplication.shared.mainMenu = mainMenu
    }

    private func installSignalHandlers() {
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.requestTermination() }
            source.resume()
            signalSources.append(source)
        }
    }

    private func requestTermination() {
        guard !isTerminating else { return }
        isTerminating = true
        // A window can be closed while the three-second debounce is still
        // waiting; the draft is flushed before the process goes away.
        model.persistDraft(force: true)
        NSApplication.shared.terminate(nil)
    }
}

@main
enum MomentsFloatMain {
    static func main() {
        if CommandLine.arguments.contains("--self-test") {
            exit(MomentsFloatSelfTest.run() ? 0 : 1)
        }

        let application = NSApplication.shared
        let delegate = FloatAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) {
            application.run()
        }
    }
}

enum MomentsFloatSelfTest {
    /// A 1x1 opaque PNG, so the self-test needs no drawing context.
    static let samplePNG = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==") ?? Data()

    static func run() -> Bool {
        var checkCount = 0
        var failures: [String] = []
        func expect(_ condition: @autoclosure () -> Bool, _ name: String) {
            checkCount += 1
            if !condition() { failures.append(name) }
        }

        do {
            let event = try HostEventParser.parse(
                #"{"type":"notes","notes":[{"id":"n1","content":"hi","createdAt":12,"pinned":true,"attachments":[]}],"total":7}"#
            )
            if case let .notes(notes, total) = event {
                expect(notes.count == 1, "notes count")
                expect(notes.first?.id == "n1", "note id")
                expect(notes.first?.pinned == true, "note pinned")
                expect(total == 7, "notes total")
            } else {
                expect(false, "notes event")
            }
        } catch {
            expect(false, "notes parsing threw")
        }

        do {
            let event = try HostEventParser.parse(#"{"type":"status","detail":"ready"}"#)
            if case let .status(detail) = event {
                expect(detail == "ready", "status detail")
            } else {
                expect(false, "status event")
            }
            let failure = try HostEventParser.parse(#"{"type":"error","detail":"boom"}"#)
            if case let .error(detail) = failure {
                expect(detail == "boom", "error detail")
            } else {
                expect(false, "error event")
            }
            let saved = try HostEventParser.parse(#"{"type":"saved","detail":"Saved"}"#)
            if case let .saved(detail) = saved {
                expect(detail == "Saved", "saved detail")
            } else {
                expect(false, "saved event")
            }
            let close = try HostEventParser.parse(#"{"type":"control","detail":"close"}"#)
            if case .close = close {
                expect(true, "close control")
            } else {
                expect(false, "close control")
            }
            let ignored = try HostEventParser.parse(#"{"type":"audio","detail":"ignored"}"#)
            if case .ignored = ignored {
                expect(true, "unknown event ignored")
            } else {
                expect(false, "unknown event ignored")
            }
        } catch {
            expect(false, "representative event parsing threw")
        }

        do {
            _ = try HostEventParser.parse("not-json")
            expect(false, "invalid JSON rejected")
        } catch {
            expect(true, "invalid JSON rejected")
        }

        let model = FloatModel()
        expect(!model.handle(line: #"{"type":"notes","notes":[{"id":"n1","content":"hello","createdAt":1,"pinned":false,"attachments":[]}],"total":1}"#), "notes does not close")
        expect(model.notes.count == 1, "model keeps the notes")
        expect(model.total == 1, "model keeps the total")
        expect(model.handle(line: #"{"type":"control","detail":"close"}"#), "model requests close")

        let malformed = FloatModel()
        _ = malformed.handle(line: "not-json")
        expect(malformed.errorMessage != nil, "malformed input is reported")

        // Images: the clipboard, a file on disk, a file URL copied in the
        // Finder, and every limit the Host will also enforce.
        let picture = MomentsFloatSelfTest.samplePNG
        expect(ImagePayload.pngData(from: picture) != nil, "a PNG without alpha survives the normaliser")
        expect(ImagePayload.pngData(from: Data("not an image".utf8)) == nil, "a non-image is refused")

        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("moments-float-self-test-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let imageURL = folder.appendingPathComponent("screenshot.png")
        let textURL = folder.appendingPathComponent("note.txt")
        try? picture.write(to: imageURL)
        try? Data("hello".utf8).write(to: textURL)
        if let payload = ImagePayload.from(fileAt: imageURL) {
            expect(payload.type == "image/png", "an image file is normalised to PNG")
            expect(payload.data.count > 0, "the file carries pixels")
            expect(payload.data.starts(with: [0x89, 0x50, 0x4E, 0x47]), "the payload really is a PNG")
        } else {
            expect(false, "an image file loads")
        }
        expect(ImagePayload.from(fileAt: textURL) == nil, "a text file is refused")

        let bytesPasteboard = NSPasteboard(name: NSPasteboard.Name("moments-float-self-test-bytes"))
        bytesPasteboard.clearContents()
        bytesPasteboard.setData(picture, forType: .png)
        expect(ImagePayload.from(bytesPasteboard) != nil, "image bytes on the clipboard are read")

        let filePasteboard = NSPasteboard(name: NSPasteboard.Name("moments-float-self-test-file"))
        filePasteboard.clearContents()
        filePasteboard.writeObjects([imageURL as NSURL])
        expect(ImagePayload.from(filePasteboard) != nil, "a file copied in the Finder is read")

        let draft = FloatModel()
        expect(draft.addImage(data: picture, type: "image/png", name: "screenshot.png") == nil, "an image attaches")
        expect(draft.attachments.count == 1, "the attachment lands in the draft")
        expect(draft.attachments.first?.name == "screenshot.png", "the file name is kept")
        expect(draft.attachments.first?.dataUrl.hasPrefix("data:image/png;base64,") == true, "the draft carries a data URL")
        expect(draft.canSave, "an image-only draft can be sent")
        if let attachment = draft.attachments.first { draft.removeAttachment(attachment) }
        expect(!draft.canSave, "removing the last image empties the draft")

        for _ in 0..<Limits.attachmentsPerNote { _ = draft.addImage(data: picture, type: "image/png") }
        expect(draft.attachments.count == Limits.attachmentsPerNote, "the draft holds the allowed number of images")
        if let problem = draft.addImage(data: picture, type: "image/png") {
            expect(problem.contains("at most"), "the count limit reports itself")
        } else {
            expect(false, "the count limit rejects one more image")
        }
        expect(draft.addImage(data: Data(count: Limits.attachmentBytes + 1), type: "image/png") != nil,
               "an image over the per-file limit is refused")

        let heavy = FloatModel()
        _ = heavy.addImage(data: Data(count: Limits.attachmentBytes), type: "image/png")
        _ = heavy.addImage(data: Data(count: Limits.attachmentBytes), type: "image/png")
        if let problem = heavy.addImage(data: Data(count: Limits.attachmentBytes), type: "image/png") {
            expect(problem.contains("total"), "the total limit reports itself")
        } else {
            expect(false, "the total limit rejects the third image")
        }

        try? FileManager.default.removeItem(at: folder)

        // Drafts: three seconds of typing are handed to the Host, and a window
        // that reopens gets the text, the images and the edit state back.
        do {
            let event = try HostEventParser.parse(
                #"{"type":"draft","draft":{"content":"草稿","editingId":"n9","attachments":[{"id":"a1","name":"s.png","type":"image/png","size":3,"dataUrl":"data:image/png;base64,AAA="}]}}"#
            )
            if case let .draft(draft) = event {
                expect(draft.content == "草稿", "draft content")
                expect(draft.editingId == "n9", "draft keeps the edit state")
                expect(draft.attachments.first?.name == "s.png", "draft keeps the image")
            } else {
                expect(false, "draft event")
            }
            let empty = try HostEventParser.parse(#"{"type":"draft","draft":{"content":"   "}}"#)
            if case .ignored = empty {
                expect(true, "an empty draft is not restored")
            } else {
                expect(false, "an empty draft is not restored")
            }
        } catch {
            expect(false, "draft parsing threw")
        }

        var sentDrafts: [[String: Any]] = []
        let drafting = FloatModel()
        drafting.onDraft = { sentDrafts.append($0) }
        drafting.content = "还没发送的文字"
        drafting.addImage(data: picture, type: "image/png", name: "shot.png")
        drafting.persistDraft()
        expect(sentDrafts.count == 1, "typing hands one draft to the Host")
        expect(sentDrafts.first?["content"] as? String == "还没发送的文字", "the draft carries the text")
        let draftRows = sentDrafts.first?["attachments"] as? [[String: Any]]
        expect(draftRows?.count == 1, "the draft carries the image")
        expect(draftRows?.first?["name"] as? String == "shot.png", "the draft keeps the image name")
        expect((draftRows?.first?["dataUrl"] as? String)?.hasPrefix("data:image/png;base64,") == true,
               "the draft carries the image bytes")

        sentDrafts.removeAll()
        let editing = FloatModel()
        editing.onDraft = { sentDrafts.append($0) }
        editing.load(FloatNote(id: "n7", content: "正在改的一条", createdAt: 0, pinned: false, attachments: []))
        editing.persistDraft()
        expect(sentDrafts.first?["editingId"] as? String == "n7", "the draft says which note is being edited")

        let reopened = FloatModel()
        var reopenedDrafts: [[String: Any]] = []
        reopened.onDraft = { reopenedDrafts.append($0) }
        reopened.restore(FloatDraft(
            content: "关窗前的文字",
            editingId: "n7",
            attachments: [DraftAttachment(id: "a9", name: "s.png", type: "image/png", size: 3,
                                          dataUrl: "data:image/png;base64,AAA=")]
        ))
        expect(reopened.content == "关窗前的文字", "the reopened window restores the text")
        expect(reopened.editingId == "n7", "the reopened window restores the edit state")
        expect(reopened.attachments.count == 1, "the reopened window restores the image")
        expect(reopened.canSave, "a restored draft can be sent")
        expect(reopened.status.contains("restored"), "the window says the draft came back")
        let beforeRestore = reopened.content
        reopened.restore(FloatDraft(content: "更旧的草稿", editingId: nil, attachments: []))
        expect(reopened.content == beforeRestore, "a restore never overwrites live typing")

        var committedDrafts: [[String: Any]] = []
        var committedCommands: [[String: Any]] = []
        let committed = FloatModel()
        committed.onDraft = { committedDrafts.append($0) }
        committed.onCommand = { committedCommands.append($0) }
        committed.content = "已经发出去的"
        _ = committed.handle(line: #"{"type":"saved","detail":"Saved"}"#)
        committed.persistDraft()
        expect(committedDrafts.isEmpty, "a saved note does not leave a draft behind")
        expect(committedCommands.contains { $0["type"] as? String == "query" }, "a save refreshes the list")

        var closedDrafts: [[String: Any]] = []
        let closed = FloatModel()
        closed.onDraft = { closedDrafts.append($0) }
        closed.persistDraft(force: true)
        expect(closedDrafts.count == 1, "closing an empty window still tells the Host")
        expect(closedDrafts.first?["content"] as? String == "", "the empty draft clears the stored one")

        if failures.isEmpty {
            print("moments-float self-test: \(checkCount) checks passed")
            return true
        }
        for failure in failures {
            FileHandle.standardError.write(Data("moments-float self-test failed: \(failure)\n".utf8))
        }
        return false
    }
}
