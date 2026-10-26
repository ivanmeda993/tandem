// Tandem's notifier on macOS: posts one notification under Tandem's own name and icon and, when the person clicks it,
// opens the link it carries (their session in the Claude app) or brings an app to the front. macOS starts this app
// again for the click after the run that posted has exited, so nothing waits in the background.
//
//   tandem-notify --title <text> --body <text> [--subtitle <text>] [--open <url>] [--activate <bundle id>]
//                 [--id <id>] [--group <id>]
//
// --id replaces the notification posted before with the same id; --group stacks notifications together.
// Exit status: 0 posted; 2 wrong arguments; 3 the person turned Tandem's notifications off (System Settings >
// Notifications) or has not answered macOS's question whether Tandem may notify; 4 macOS refused this app or the
// notification (an app in a temporary folder, for one).

import AppKit
import CoreServices
import UserNotifications

struct Note {
    var title = ""
    var subtitle = ""
    var body = ""
    var open: String?
    var activate: String?
    var id: String?
    var group: String?
}

// How long a first post waits for the person to answer macOS's question whether Tandem may notify.
let askSeconds = 100.0

func fail(_ status: Int32, _ message: String) -> Never {
    FileHandle.standardError.write(Data("tandem-notify: \(message)\n".utf8))
    exit(status)
}

// The notification to post, or nil when macOS (or a person) started the app with nothing to post.
func parse(_ args: [String]) -> Note? {
    guard args.contains("--title") || args.contains("--body") else { return nil }
    var note = Note()
    var rest = args[...]
    while let flag = rest.popFirst() {
        guard let value = rest.popFirst() else { fail(2, "\(flag) needs a value") }
        switch flag {
        case "--title": note.title = value
        case "--subtitle": note.subtitle = value
        case "--body": note.body = value
        case "--open": note.open = value
        case "--activate": note.activate = value
        case "--id": note.id = value
        case "--group": note.group = value
        default: fail(2, "unknown option \(flag)")
        }
    }
    if note.title.isEmpty && note.body.isEmpty { fail(2, "--title or --body must say something") }
    if let open = note.open, URL(string: open)?.scheme == nil { fail(2, "--open needs a URL") }
    return note
}

final class Notifier: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let note: Note?

    init(note: Note?) {
        self.note = note
    }

    // Set before launching ends, so a click that started the app reaches it.
    func applicationWillFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let note else {
            quit(after: 10)
            return
        }
        // So macOS starts this copy for the click, wherever the plugin is installed.
        LSRegisterURL(Bundle.main.bundleURL as CFURL, false)
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                DispatchQueue.main.asyncAfter(deadline: .now() + askSeconds) {
                    fail(3, "nobody answered whether Tandem may send notifications")
                }
                center.requestAuthorization(options: [.alert, .sound]) { granted, error in
                    if let error { fail(4, error.localizedDescription) }
                    guard granted else { fail(3, "the person did not allow Tandem's notifications") }
                    self.add(note)
                }
            case .denied:
                fail(3, "notifications are off for Tandem in System Settings > Notifications")
            default:
                self.add(note)
            }
        }
    }

    func add(_ note: Note) {
        let content = UNMutableNotificationContent()
        content.title = note.title
        content.subtitle = note.subtitle
        content.body = note.body
        if let group = note.group { content.threadIdentifier = group }
        var info: [String: String] = [:]
        if let open = note.open { info["open"] = open }
        if let activate = note.activate { info["activate"] = activate }
        content.userInfo = info
        let request = UNNotificationRequest(identifier: note.id ?? UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { fail(4, error.localizedDescription) }
            exit(0)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        guard response.actionIdentifier != UNNotificationDismissActionIdentifier else {
            completionHandler()
            return
        }
        open(response.notification.request.content.userInfo) {
            completionHandler()
            self.quit(after: 1)
        }
    }

    // A notification that comes while this app is in front still shows.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list])
    }

    // The link first; the app when there is none or nothing opens it.
    func open(_ info: [AnyHashable: Any], then done: @escaping () -> Void) {
        let config = NSWorkspace.OpenConfiguration()
        guard let link = info["open"] as? String, let url = URL(string: link) else {
            activate(info, config, then: done)
            return
        }
        NSWorkspace.shared.open(url, configuration: config) { _, error in
            if error == nil { done() } else { self.activate(info, config, then: done) }
        }
    }

    func activate(_ info: [AnyHashable: Any], _ config: NSWorkspace.OpenConfiguration, then done: @escaping () -> Void) {
        guard let id = info["activate"] as? String,
              let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id)
        else {
            done()
            return
        }
        NSWorkspace.shared.openApplication(at: app, configuration: config) { _, _ in done() }
    }

    func quit(after seconds: Double) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { NSApp.terminate(nil) }
    }
}

let notifier = Notifier(note: parse(Array(CommandLine.arguments.dropFirst())))
let app = NSApplication.shared
app.delegate = notifier
app.run()
