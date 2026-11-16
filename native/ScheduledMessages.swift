import SwiftUI
import AppKit
import Foundation

private struct ScheduledDeliveryEvidence:Decodable {
    let code:String?
    let clickCommitted:Bool?
    let editorCleared:Bool?
    let messageFound:Bool?
    let userCountDelta:Int?
    let userInsertionDelta:Int?
    let checks:Int?
    let urlMatched:Bool?
    let stopVisible:Bool?
    let streamingVisible:Bool?
    let connectionInterrupted:Bool?
    let assistantActivitySeen:Bool?
    let virtualizedProof:Bool?
}
private struct ScheduledVerification:Decodable {
    let checks:Int
    let deadlineAt:String
    let nextCheckAt:String
    let lastObservation:String?
    let lastEvidence:ScheduledDeliveryEvidence?
    let manualRechecks:Int?
}
private struct ScheduledChatMessage: Decodable, Identifiable {
    let id:String
    let url:String
    let message:String
    let interval_seconds:Int
    let schedule_mode:String?
    let run_at:String?
    let time_zone:String?
    let local_time:String?
    let weekdays:[Int]?
    let end_at:String?
    let delay_seconds:Int?
    let max_continuations:Int?
    let continuations_sent:Int?
    let enabled:Bool
    let next_at:String?
    let status:String
    let last_error:String
    let last_attempt_at:String?
    let last_success_at:String?
    let delivery_count:Int
    let delivery_stage:String?
    let last_stage_at:String?
    let safe_retry_count:Int?
    let manual_once:Bool?
    let verification:ScheduledVerification?
    let created_at:String
}
private struct DeliveryAttempt: Decodable, Identifiable {
    let id:String
    let task_id:String
    let time:String
    let result:String
    let slot_id:String?
    let scheduled_at:String?
    let started_at:String?
    let duration_ms:Int?
    let stage:String?
    let error:String
    let diagnostic:ScheduledDeliveryEvidence?
}
private struct ChromePageDiagnostic: Decodable {
    let at:String?
    let ready:String?
    let visibility:String?
    let editorId:Int?
    let contentEditable:Int?
    let visibleEditable:Int?
    let roleTextbox:Int?
    let textareas:Int?
    let userMessages:Int?
    let conversationTurns:Int?
    let mainTextLength:Int?
    let titleLength:Int?
    let titleGeneric:Bool?
    let sendButtons:Int?
    let sameURL:Bool?
    let tabActive:Bool?
}
private struct AutoSendConversation:Decodable {
    let state:String
    let blocked:Bool
    let reason:String?
    let owner_task_id:String?
}
private struct ScheduledHistorySummary:Decodable {
    let verified:Int
    let skipped:Int
    let unknown:Int
    let other:Int
}
private struct AutoSendResponse: Decodable {
    let ok:Bool?
    let tasks:[ScheduledChatMessage]?
    let attempts:[DeliveryAttempt]?
    let conversations:[String:AutoSendConversation]?
    let historySummary:ScheduledHistorySummary?
    let ready:Bool?
    let reason:String?
    let chatFound:Bool?
    let sendBlocked:Bool?
    let deliverySupported:Bool?
    let deliveryReason:String?
    let extensionConnected:Bool?
    let extensionTransport:String?
    let extensionLastSeen:String?
    let extensionDiagnostic:ChromePageDiagnostic?
    let extensionVersion:String?
    let requiredExtensionVersion:String?
    let token:String?
    let busyTask:String?
    let error:String?
}

@MainActor private final class AutoSendModel: ObservableObject {
    @Published var tasks:[ScheduledChatMessage]=[]
    @Published var attempts:[DeliveryAttempt]=[]
    @Published var conversations:[String:AutoSendConversation]=[:]
    @Published var historySummary:ScheduledHistorySummary?
    @Published var preflightResults:[String:String]=[:]
    @Published var deliverySupported=false
    @Published var extensionConnected=false
    @Published var extensionTransport="Playwright MCP · расширение Chrome"
    @Published var extensionLastSeen:String?
    @Published var extensionDiagnostic:ChromePageDiagnostic?
    @Published var extensionVersion="Playwright Extension"
    @Published var requiredExtensionVersion="Playwright Extension"
    @Published var deliveryReason="Проверка подключения к Playwright Extension AutoSend…"
    @Published var error:String?
    @Published var notice:String?
    @Published var loading=false
    @Published var busyTask=""
    @Published private(set) var lastUpdated:Date?
    private var refreshInFlight=false
    private let base=URL(string:"http://127.0.0.1:8972")!

    private func request(_ endpoint:String, payload:[String:Any]?=nil) async throws -> AutoSendResponse {
        var req=URLRequest(url:base.appendingPathComponent(endpoint))
        req.setValue("native",forHTTPHeaderField:"X-MCPHub-Client")
        let tokenFile=FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/McpGo/AutoSend/control-token")
        let token=try String(contentsOf:tokenFile,encoding:.utf8).trimmingCharacters(in:.whitespacesAndNewlines)
        guard token.count==64 else {
            throw NSError(domain:"MCPHubAutoSend",code:403,
                userInfo:[NSLocalizedDescriptionKey:"Локальная авторизация AutoSend не настроена."])
        }
        req.setValue(token,forHTTPHeaderField:"X-MCPHub-Token")
        req.timeoutInterval=75
        if let payload {
            req.httpMethod="POST"
            req.setValue("application/json",forHTTPHeaderField:"Content-Type")
            req.httpBody=try JSONSerialization.data(withJSONObject:payload)
        }
        let (data,response)=try await URLSession.shared.data(for:req)
        let decoded=try JSONDecoder().decode(AutoSendResponse.self,from:data)
        guard let http=response as? HTTPURLResponse,(200..<300).contains(http.statusCode) else {
            throw NSError(domain:"MCPHubAutoSend",code:1,
                userInfo:[NSLocalizedDescriptionKey:decoded.error ?? "Служба расписаний не отвечает."])
        }
        return decoded
    }
    func refresh() async {
        // The view polling loop and manual refresh can arrive together.
        // Never let a late status response overwrite a newer state update.
        guard !refreshInFlight, !loading else { return }
        refreshInFlight=true
        defer { refreshInFlight=false }
        do {
            let state=try await request("api/status")
            tasks=state.tasks ?? []
            attempts=state.attempts ?? []
            conversations=state.conversations ?? [:]
            historySummary=state.historySummary
            deliverySupported=state.deliverySupported ?? false
            extensionConnected=state.extensionConnected ?? false
            extensionTransport=state.extensionTransport ?? "не определён"
            extensionLastSeen=state.extensionLastSeen
            extensionDiagnostic=state.extensionDiagnostic
            extensionVersion=state.extensionVersion ?? "не определена"
            requiredExtensionVersion=state.requiredExtensionVersion ?? "Playwright Extension"
            deliveryReason=state.deliveryReason ?? "Нет подтверждённого транспорта отправки."
            busyTask=state.busyTask ?? ""
            lastUpdated=Date()
            error=nil
        } catch {self.error=error.localizedDescription}
    }
    func copyExtensionCode() async {
        loading=true
        defer {loading=false}
        do {
            let response=try await request("api/extension/setup")
            guard let key=response.token, key.count==64 else {
                throw NSError(domain:"MCPHubAutoSend",code:2,
                    userInfo:[NSLocalizedDescriptionKey:"Не удалось получить код сопряжения."])
            }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(key,forType:.string)
            notice="Код сопряжения скопирован. Вставь его в окно расширения McpGo Scheduler в Chrome."
            error=nil
        } catch {self.error=error.localizedDescription}
    }

    func preview(_ taskID:String) async {
        guard !loading else {return}
        loading=true
        defer {loading=false}
        do {
            let result=try await request("api/tasks",payload:["action":"preview","id":taskID])
            let checkedTime=Date().formatted(date:.omitted,time:.shortened)
            preflightResults[taskID]=(result.ready == true ? "✅ " : "⚠️ ") +
                (result.reason ?? "Не удалось определить готовность разговора.") +
                " · Проверено в " + checkedTime + " · Send не нажимался"
            error=nil
        } catch {preflightResults[taskID]="Проверка не удалась: " + error.localizedDescription}
    }
    func execute(_ action:String, values:[String:Any]=[:]) async -> Bool {
        loading=true
        defer {loading=false}
        do {
            let body=["action":action].merging(values){_,new in new}
            _ = try await request("api/tasks",payload:body)
            // A check is a point-in-time observation, not a persistent
            // status. Clear the old result whenever its task is changed.
            if ["update","start","pause","remove"].contains(action),
               let taskID=values["id"] as? String {
                preflightResults.removeValue(forKey:taskID)
            }
            notice = switch action {
            case "create": "Расписание создано выключенным. Проверь URL и включи его самостоятельно."
            case "start": "Расписание включено. Следующее действие — согласно выбранному режиму."
            case "pause": "Расписание остановлено."
            case "remove": "Расписание удалено."
            case "send_once": "Запрос поставлен в очередь Playwright. Результат появится в журнале."
            case "clear_history": "Журнал отправок очищен."
            case "recheck_unknown": "Запущена повторная проверка без Send. Новое сообщение не отправляется."
            case "confirm_received": "Отмечено как подтверждённое вручную. Расписание осталось выключенным; Send не нажимался."
            default:"Настройки сохранены."
            }
            loading=false
            await refresh()
            return true
        } catch {self.error=error.localizedDescription;return false}
    }
}

struct ScheduledMessagesView:View {
    @StateObject private var model=AutoSendModel()
    @State private var url=""
    @State private var message=""
    @State private var interval="30"
    @State private var intervalUnit="minutes"
    @State private var scheduleMode="interval"
    @State private var runAt=Date().addingTimeInterval(3600)
    @State private var timeZoneID=TimeZone.current.identifier
    @State private var localTime="10:00"
    @State private var weekdays:Set<Int>=[1,2,3,4,5]
    @State private var hasEndDate=false
    @State private var endDate=Date().addingTimeInterval(30*86400)
    @State private var delaySeconds="30"
    @State private var maxContinuations="20"
    @State private var editingTaskID:String?
    @State private var confirmation:Confirmation?
    @State private var showingHistory=false
    // A stable SwiftUI task keeps polling across body re-renderings.
    // Timer.publish stored in a transient View value can lose its subscription
    // after @StateObject changes (especially after a completed delivery).

    private struct Confirmation:Identifiable {
        let id:String
        let action:String
        let title:String
        let explanation:String
    }
    private var isSharedLink:Bool {url.contains("chatgpt.com/share/")}
    private var cleanedWebChatInput:String {
        // Copy/paste from formatted text may substitute Unicode dashes for
        // ASCII '-' or inject zero-width separators. The backend only accepts
        // ASCII UUIDs; canonicalize visual equivalents before validation.
        var cleaned=url.trimmingCharacters(in:.whitespacesAndNewlines)
        for separator in ["\u{200B}","\u{200C}","\u{200D}","\u{FEFF}"] {
            cleaned=cleaned.replacingOccurrences(of:separator,with:"")
        }
        for dash in ["\u{2010}","\u{2011}","\u{2012}","\u{2013}",
                     "\u{2014}","\u{2212}","\u{FE63}","\u{FF0D}"] {
            cleaned=cleaned.replacingOccurrences(of:dash,with:"-")
        }
        return cleaned
    }
    private var normalizedWebChatURL:String? {
        // Exact same accepted path shapes as normalizeTarget() in core.mjs.
        let input=cleanedWebChatInput
        guard input.count<=1000,let components=URLComponents(string:input),
              components.scheme?.lowercased()=="https",
              components.host?.lowercased()=="chatgpt.com",
              components.port==nil,components.user==nil,
              components.password==nil,components.fragment==nil else {return nil}
        let pattern=#"^(?:/g/g-p-[a-zA-Z0-9][a-zA-Z0-9-]{2,160})?/c/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/?$"#
        let path=components.percentEncodedPath
        guard path.range(of:pattern,options:.regularExpression) != nil else {return nil}
        let canonicalPath=path.hasSuffix("/") ? String(path.dropLast()) : path
        return "https://chatgpt.com" + canonicalPath.lowercased()
    }
    private var invalidWebChatURLIssue:String {
        guard let parts=URLComponents(string:cleanedWebChatInput) else {
            return "Вставленная ссылка содержит символы, которые нельзя разобрать как URL."
        }
        guard parts.scheme?.lowercased()=="https",parts.host?.lowercased()=="chatgpt.com" else {
            return "Нужна ссылка с адресом https://chatgpt.com/."
        }
        if parts.fragment != nil {return "Удали часть ссылки после символа #."}
        if let id=parts.path.components(separatedBy:"/c/").last,
           parts.path.contains("/c/"),id.count != 36 {
            return "ID чата неполный или содержит лишние символы: должно быть 36 символов, сейчас \(id.count)."
        }
        return "Не удалось распознать путь разговора. Скопируй адрес из Chrome целиком."
    }
    private var seconds:Int {
        let v=Int(interval) ?? 0
        let multiplier=intervalUnit=="hours" ? 3600 : intervalUnit=="days" ? 86400 : 60
        let (value,overflow)=v.multipliedReportingOverflow(by:multiplier)
        return overflow ? 0 : value
    }
    private var formValidationIssue:String? {
        if url.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {
            return "Укажи ссылку на существующий чат ChatGPT."
        }
        if isSharedLink {
            return "Ссылка /share/ не подходит — нужна исходная ссылка разговора /c/."
        }
        if normalizedWebChatURL == nil {
            return invalidWebChatURLIssue
        }
        if message.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {
            return "Напиши сообщение, которое будет отправляться по расписанию."
        }
        if message.count>8000 {return "Сообщение должно быть не длиннее 8000 символов."}
        switch scheduleMode {
        case "once":
            if runAt<=Date(){return "Выбери дату и время в будущем."}
        case "daily","weekly":
            if TimeZone(identifier:timeZoneID)==nil {return "Укажи существующий часовой пояс, например Europe/Moscow."}
            if localTime.range(of:#"^([01][0-9]|2[0-3]):[0-5][0-9]$"#,options:.regularExpression)==nil {
                return "Укажи время в формате ЧЧ:ММ, например 10:00."
            }
            if scheduleMode=="weekly" && weekdays.isEmpty {return "Выбери хотя бы один день недели."}
            if hasEndDate && endDate<=Date() {return "Дата окончания должна быть в будущем."}
        case "after_response":
            let delay=Int(delaySeconds) ?? 0
            let limit=Int(maxContinuations) ?? 0
            if !(10...3600).contains(delay) {return "Пауза после ответа должна составлять 10–3600 секунд."}
            if !(1...200).contains(limit) {return "Укажи лимит продолжений от 1 до 200."}
        default:
            if !(60...604800).contains(seconds) {return "Интервал должен составлять от 1 минуты до 7 дней."}
        }
        return nil
    }
    private func displayDate(_ iso:String?) -> String {
        guard let iso else{return "—"}
        let precise=ISO8601DateFormatter()
        precise.formatOptions=[.withInternetDateTime,.withFractionalSeconds]
        guard let d=precise.date(from:iso) ?? ISO8601DateFormatter().date(from:iso) else{return "—"}
        return d.formatted(date:.abbreviated,time:.shortened)
    }
    private func scheduleDescription(_ task:ScheduledChatMessage)->String {
        switch task.schedule_mode ?? "interval" {
        case "once":return "Однократно · " + displayDate(task.run_at)
        case "daily":return "Ежедневно в " + (task.local_time ?? "—") + " · " + (task.time_zone ?? "")
        case "weekly":
            let names=["Вс","Пн","Вт","Ср","Чт","Пт","Сб"]
            return "По дням: " + (task.weekdays ?? []).filter{$0>=0 && $0<7}.map{names[$0]}.joined(separator:", ") +
                " · " + (task.local_time ?? "—")
        case "after_response":
            return "После ответа · пауза " + String(task.delay_seconds ?? 30) + " сек · " +
                String(task.continuations_sent ?? 0) + "/" + String(task.max_continuations ?? 20)
        default:return shortInterval(task.interval_seconds)
        }
    }
    private func shortInterval(_ seconds:Int)->String {
        if seconds % 86400 == 0 {return "Каждые \(seconds/86400) дн."}
        if seconds % 3600 == 0 {return "Каждые \(seconds/3600) ч."}
        return "Каждые \(seconds/60) мин."
    }
    private func attemptDescription(_ attempt:DeliveryAttempt)->String {
        switch attempt.result {
        case "verified":return "Сообщение появилось в чате"
        case "verified_manual":return "Пользователь подтвердил отправку вручную"
        case "busy":return "Агент занят · отправки не было"
        case "deferred":return "Отложено до следующего интервала"
        case "verifying":return "Проверяем отправку без повторного Send"
        case "retry":return "Ожидание без отправки"
        case "blocked":return "Отправка заблокирована"
        default:return "Результат неизвестен"
        }
    }
    private func evidenceDescription(_ e:ScheduledDeliveryEvidence)->String {
        let status:String
        switch e.code ?? "" {
        case "USER_BUBBLE_VERIFIED":status="Новая пользовательская реплика подтверждена"
        case "USER_BUBBLE_VERIFIED_VIRTUALIZED":status="Новая реплика подтверждена несколькими признаками, несмотря на свёрнутый DOM"
        case "USER_BUBBLE_NOT_FOUND":status="Новая пользовательская реплика пока не найдена"
        case "USER_TEXT_MISMATCH":status="Последняя реплика не совпала с заданием"
        case "TAB_UNAVAILABLE":status="Вкладка разговора недоступна для проверки"
        case "WRONG_CONVERSATION":status="Вкладка открыла другой разговор"
        case "OBSERVATION_FAILED":status="Состояние страницы не удалось прочитать"
        case "READY_NOT_STABLE":status="Страница менялась во время проверки готовности"
        case "PRECLICK_NOT_READY","PRECLICK_BUSY":status="До Send обнаружено изменение состояния"
        case "CONNECTION_INTERRUPTED":status="ChatGPT сообщил об обрыве ответа"
        default:status="Подтверждение не получено"
        }
        var facts=[status]
        if e.clickCommitted == true {facts.append("Send мог быть нажат; повтор запрещён")}
        if e.editorCleared == true {facts.append("Поле ввода очистилось")}
        else if e.editorCleared == false {facts.append("Очистка поля ввода не подтверждена")}
        if e.messageFound == false {facts.append("Новая реплика пока не подтверждена")}
        if e.assistantActivitySeen == true {facts.append("Есть признаки нового ответа агента")}
        if e.virtualizedProof == true {facts.append("Проверены вставка реплики, очистка ввода и ответ агента")}
        if let checks=e.checks {facts.append("Проверок: \(checks)")}
        if let delta=e.userCountDelta {facts.append("Изменение видимого числа реплик: \(delta)")}
        if let inserted=e.userInsertionDelta, inserted>0 {
            facts.append("Обнаружены добавления элементов в DOM: \(inserted); это не доказательство отправки")
        }
        return facts.joined(separator:" · ")
    }

    private func conversationDescription(_ state:String)->String {
        switch state {
        case "READY":return "Ожидает проверки по расписанию"
        case "VERIFYING_SEND":return "Проверка Send без повтора"
        case "UNKNOWN":return "Неизвестный результат · отправка заблокирована"
        default:return "Расписание не активно"
        }
    }
    private func stateDescription(_ t:ScheduledChatMessage)->String {
        switch t.status {
        case "scheduled":
            if (t.safe_retry_count ?? 0)>0 {return "Ожидание повторной проверки"}
            if t.last_error.contains("Агент занят") {return "Агент занят · ожидание"}
            return t.enabled ? "Включено" : "Ожидает разовую отправку"
        case "checking":return "Проверка занятости агента…"
        case "sending":return "Отправка…"
        case "verifying":return "Проверяем доставку · без повторной отправки"
        case "verified":return "Подтверждено"
        case "verified_manual":return "Подтверждено вручную"
        case "unknown":return "Нужна проверка"
        case "blocked":return "Требуется внимание"
        default:return "Приостановлено"
        }
    }
    private func stateColor(_ t:ScheduledChatMessage)->Color {
        if t.status=="scheduled" {return Palette.online}
        if t.status=="blocked" || t.status=="unknown" {return Palette.warning}
        if t.status=="verifying" {return Palette.accent}
        return Palette.muted
    }

    var body:some View {
        ScrollView {
            VStack(alignment:.leading,spacing:17) {
                HStack(alignment:.center) {
                    VStack(alignment:.leading,spacing:7) {
                        Text("SCHEDULED DELIVERY")
                            .font(.system(size:10,weight:.bold,design:.monospaced))
                            .tracking(1.6).foregroundStyle(Palette.accent)
                        Text("Сообщения по таймеру")
                            .font(.system(size:27,weight:.bold,design:.rounded)).foregroundStyle(Palette.ink)
                        Text("Отправка сообщений в указанный разговор ChatGPT по расписанию")
                            .font(.system(size:12)).foregroundStyle(Palette.muted)
                    }
                    Spacer()
                    Button { Task {await model.refresh()} } label: {
                        Label("Обновить",systemImage:"arrow.clockwise")
                    }.buttonStyle(HubInteractiveButtonStyle(treatment:.bordered))
                }
                HStack(alignment:.top,spacing:10) {
                    Image(systemName:"info.circle.fill").foregroundStyle(Palette.accent)
                    Text("McpGo проверяет указанный чат через расширение Playwright MCP в личном Google Chrome. Если агент отвечает или состояние чата неясно — пропускает попытку до следующего интервала. При подтверждённой отправке повторов нет. Для первого запуска расписание включается вручную.")
                        .font(.system(size:11.5)).foregroundStyle(Palette.muted)
                        .fixedSize(horizontal:false,vertical:true)
                }
                .padding(13)
                .background(Palette.accentSoft.opacity(0.5),in:RoundedRectangle(cornerRadius:11))
                VStack(alignment:.leading,spacing:11) {
                    HStack(spacing:10) {
                        Image(systemName:"globe")
                            .font(.system(size:20)).foregroundStyle(Palette.accent)
                        VStack(alignment:.leading,spacing:4) {
                            Text("Playwright MCP · расширение Chrome")
                                .font(.system(size:13,weight:.semibold)).foregroundStyle(Palette.ink)
                            Text(model.extensionConnected ? "Подключено · браузер готов к проверкам" : "Нет соединения · проверка повторится автоматически")
                                .font(.system(size:11)).foregroundStyle(model.extensionConnected ? Palette.online : Palette.warning)
                        }
                        Spacer()
                        Circle().fill(model.extensionConnected ? Palette.online : Palette.warning).frame(width:8,height:8)
                    }
                    Text(model.deliveryReason)
                        .font(.system(size:11)).foregroundStyle(Palette.muted)
                        .fixedSize(horizontal:false,vertical:true)
                    Text("Работает через существующий Chrome. Отдельные расширения, токены и второй профиль не требуются.")
                        .font(.system(size:10.5)).foregroundStyle(Palette.muted)
                }
                .padding(15)
                .background(Palette.panel,in:RoundedRectangle(cornerRadius:13))
                .overlay(RoundedRectangle(cornerRadius:13).stroke(Palette.stroke))

                VStack(alignment:.leading,spacing:13) {
                    HStack {
                        Image(systemName:"plus.circle.fill").foregroundStyle(Palette.accent)
                        Text(editingTaskID == nil ? "Новое расписание" : "Изменить расписание")
                            .font(.system(size:15,weight:.semibold)).foregroundStyle(Palette.ink)
                    }
                    VStack(alignment:.leading,spacing:6) {
                        Text("Ссылка на разговор ChatGPT (обычный или в проекте)")
                            .font(.system(size:11,weight:.semibold)).foregroundStyle(Palette.muted)
                        TextField("https://chatgpt.com/c/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",text:$url)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(size:11.5,design:.monospaced))
                        if isSharedLink {
                            Label("Это опубликованная копия, не адрес для отправки. Используй оригинальную ссылку /c/.",systemImage:"exclamationmark.triangle")
                                .font(.system(size:11)).foregroundStyle(Palette.warning)
                                .fixedSize(horizontal:false,vertical:true)
                        } else if url.hasPrefix("codex://") {
                            Label("Ссылка Codex указывает на другой тип разговора и не соответствует твоему чату /c/.",systemImage:"exclamationmark.triangle")
                                .font(.system(size:11)).foregroundStyle(Palette.warning)
                        }
                    }
                    VStack(alignment:.leading,spacing:6) {
                        HStack {
                            Text("Сообщение, которое будет отправляться")
                                .font(.system(size:11,weight:.semibold)).foregroundStyle(Palette.muted)
                            Spacer()
                            Text("\(message.count)/8000").font(.system(size:10)).foregroundStyle(Palette.quiet)
                        }
                        TextEditor(text:$message)
                            .font(.system(size:12.5)).foregroundStyle(Palette.ink)
                            .scrollContentBackground(.hidden)
                            .frame(height:91)
                            .padding(7)
                            .background(Palette.inner,in:RoundedRectangle(cornerRadius:9))
                            .overlay(RoundedRectangle(cornerRadius:9).stroke(Palette.stroke))
                    }
                    VStack(alignment:.leading,spacing:10) {
                        Picker("Режим расписания",selection:$scheduleMode) {
                            Text("Каждые N минут / часов").tag("interval")
                            Text("Однократно в дату и время").tag("once")
                            Text("Ежедневно в определённое время").tag("daily")
                            Text("По выбранным дням недели").tag("weekly")
                            Text("После завершения ответа ИИ").tag("after_response")
                        }.pickerStyle(.menu)
                        switch scheduleMode {
                        case "once":
                            DatePicker("Когда отправить",selection:$runAt,
                                       displayedComponents:[.date,.hourAndMinute])
                                .datePickerStyle(.compact)
                        case "daily","weekly":
                            HStack(spacing:12) {
                                VStack(alignment:.leading,spacing:4) {
                                    Text("Время (ЧЧ:ММ)").font(.system(size:10.5)).foregroundStyle(Palette.muted)
                                    TextField("10:00",text:$localTime)
                                        .textFieldStyle(.roundedBorder).frame(width:92)
                                }
                                VStack(alignment:.leading,spacing:4) {
                                    Text("Часовой пояс").font(.system(size:10.5)).foregroundStyle(Palette.muted)
                                    TextField("Europe/Moscow",text:$timeZoneID).textFieldStyle(.roundedBorder)
                                }
                            }
                            if scheduleMode == "weekly" {
                                HStack(spacing:5) {
                                    ForEach(0..<7,id: \.self) { index in
                                        let names=["Вс","Пн","Вт","Ср","Чт","Пт","Сб"]
                                        Button(names[index]) {
                                            if weekdays.contains(index) {weekdays.remove(index)}
                                            else {weekdays.insert(index)}
                                        }
                                        .buttonStyle(HubInteractiveButtonStyle(treatment:.bordered))
                                        .foregroundStyle(weekdays.contains(index) ? Palette.online : Palette.muted)
                                    }
                                }
                            }
                            Toggle("Дата окончания",isOn:$hasEndDate).toggleStyle(.switch)
                            if hasEndDate {
                                DatePicker("Окончание",selection:$endDate,
                                           displayedComponents:[.date,.hourAndMinute])
                            }
                        case "after_response":
                            HStack(spacing:12) {
                                VStack(alignment:.leading,spacing:4) {
                                    Text("Пауза после ответа (сек.)").font(.system(size:10.5)).foregroundStyle(Palette.muted)
                                    TextField("30",text:$delaySeconds).textFieldStyle(.roundedBorder).frame(width:95)
                                }
                                VStack(alignment:.leading,spacing:4) {
                                    Text("Максимум продолжений").font(.system(size:10.5)).foregroundStyle(Palette.muted)
                                    TextField("20",text:$maxContinuations).textFieldStyle(.roundedBorder).frame(width:95)
                                }
                            }
                            Text("Начнёт работу только после замеченного ответа ИИ. Простой открытой вкладки недостаточно.")
                                .font(.system(size:10.5)).foregroundStyle(Palette.quiet)
                        default:
                            HStack(spacing:10) {
                                Text("Повторять каждые").font(.system(size:11)).foregroundStyle(Palette.muted)
                                TextField("30",text:$interval).textFieldStyle(.roundedBorder).frame(width:90)
                                Picker("Единица",selection:$intervalUnit) {
                                    Text("минут").tag("minutes")
                                    Text("часов").tag("hours")
                                    Text("дней").tag("days")
                                }.labelsHidden().frame(width:112)
                            }
                        }
                    }
                    HStack(alignment:.bottom,spacing:10) {
                        Spacer()
                        if editingTaskID != nil {
                            Button("Отмена") { resetForm() }
                                .buttonStyle(HubInteractiveButtonStyle(treatment:.bordered))
                        }
                        Button {
                            guard let normalizedURL=normalizedWebChatURL,formValidationIssue==nil else {
                                return
                            }
                            let action=editingTaskID == nil ? "create" : "update"
                            var values:[String:Any]=["url":normalizedURL,"message":message,
                                                     "interval_seconds":min(604800,max(60,seconds)),"schedule_mode":scheduleMode]
                            switch scheduleMode {
                            case "once":values["run_at"]=ISO8601DateFormatter().string(from:runAt)
                            case "daily","weekly":
                                values["time_zone"]=timeZoneID
                                values["local_time"]=localTime
                                if scheduleMode == "weekly" {values["weekdays"]=weekdays.sorted()}
                                values["end_at"]=hasEndDate ? ISO8601DateFormatter().string(from:endDate) : NSNull()
                            case "after_response":
                                values["delay_seconds"]=Int(delaySeconds) ?? 30
                                values["max_continuations"]=Int(maxContinuations) ?? 20
                            default:break
                            }
                            if let editingTaskID {values["id"]=editingTaskID}
                            Task {
                                if await model.execute(action,values:values) {resetForm()}
                            }
                        } label: {
                            Label(editingTaskID == nil ? "Добавить расписание" : "Сохранить изменения",
                                  systemImage: editingTaskID == nil ? "plus" : "checkmark")
                                .font(.system(size:12,weight:.semibold)).foregroundStyle(Color(hex:0x121526))
                        }
                        // Validation is explained instead of silently disabling the button.
                        .buttonStyle(HubInteractiveButtonStyle(treatment:.filled)).disabled(model.loading)
                    }
                    if let issue=formValidationIssue {
                        Label(issue,systemImage:"info.circle")
                            .font(.system(size:10.5)).foregroundStyle(Palette.warning)
                            .fixedSize(horizontal:false,vertical:true)
                    }
                    Text(editingTaskID == nil ?
                         "Созданные расписания выключены. Поддерживаются обычные и проектные чаты. Первая отправка — через выбранный интервал после нажатия «Включить»." :
                         "Изменение параметров остановит расписание. Включи его после проверки URL и текста.")
                        .font(.system(size:10.5)).foregroundStyle(Palette.quiet)
                }
                .padding(17)
                .background(Palette.panel,in:RoundedRectangle(cornerRadius:14))
                .overlay(RoundedRectangle(cornerRadius:14).stroke(Palette.stroke))

                HStack {
                    Text("Расписания · \(model.tasks.count)")
                        .font(.system(size:15,weight:.semibold)).foregroundStyle(Palette.ink)
                    Spacer()
                }
                if model.tasks.isEmpty {
                    VStack(spacing:11) {
                        Image(systemName:"clock.badge.checkmark").font(.system(size:26)).foregroundStyle(Palette.quiet)
                        Text("Пока нет расписаний").font(.system(size:13,weight:.semibold)).foregroundStyle(Palette.ink)
                        Text("Вставь ссылку /c/UUID, введи текст и интервал. Новые расписания создаются выключенными.")
                            .font(.system(size:11)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                    }
                    .frame(maxWidth:.infinity).padding(.vertical,28)
                    .background(Palette.panel,in:RoundedRectangle(cornerRadius:13))
                }
                ForEach(model.tasks) { task in
                    scheduleCard(task)
                }
                if !model.attempts.isEmpty {
                    DisclosureGroup(isExpanded:$showingHistory) {
                        VStack(alignment:.leading,spacing:9) {
                            ForEach(model.attempts) { attempt in
                                HStack(alignment:.top,spacing:9) {
                                    Image(systemName:["verified","verified_manual"].contains(attempt.result) ? "checkmark.circle.fill" :
                                        attempt.result=="busy" || attempt.result=="deferred" || attempt.result=="verifying" ? "clock.arrow.circlepath" : "exclamationmark.triangle.fill")
                                        .foregroundStyle(["verified","verified_manual"].contains(attempt.result) ? Palette.online :
                                            attempt.result=="busy" || attempt.result=="deferred" || attempt.result=="verifying" ? Palette.accent : Palette.warning)
                                    VStack(alignment:.leading,spacing:4) {
                                        Text("\(displayDate(attempt.time)) · \(attemptDescription(attempt))")
                                            .font(.system(size:11,weight:.medium)).foregroundStyle(Palette.ink)
                                        if let planned=attempt.scheduled_at {
                                            Text("По плану: " + displayDate(planned) +
                                                 (attempt.duration_ms != nil ? " · \(attempt.duration_ms! / 1000) сек." : ""))
                                                .font(.system(size:10)).foregroundStyle(Palette.quiet)
                                        }
                                        if !attempt.error.isEmpty {
                                            Text(attempt.error).font(.system(size:10.5)).foregroundStyle(Palette.muted)
                                                .fixedSize(horizontal:false,vertical:true)
                                        }
                                        if let evidence=attempt.diagnostic {
                                            DisclosureGroup("Детали проверки") {
                                                Text(evidenceDescription(evidence))
                                                    .font(.system(size:10.5)).foregroundStyle(Palette.muted)
                                                    .fixedSize(horizontal:false,vertical:true)
                                            }
                                            .font(.system(size:10,weight:.medium))
                                            .foregroundStyle(Palette.quiet)
                                        }
                                    }
                                    Spacer()
                                }
                            }
                        }.padding(.top,12)
                    } label: {
                        HStack(spacing:10) {
                            Text("Журнал · успехов: \(model.historySummary?.verified ?? 0) · пропусков: \(model.historySummary?.skipped ?? 0) · неизвестных: \(model.historySummary?.unknown ?? 0)")
                                .font(.system(size:12,weight:.semibold))
                                .foregroundStyle(Palette.muted)
                            Spacer()
                            Button {
                                confirmation=Confirmation(id:"",action:"clear_history",
                                    title:"Очистить журнал отправок?",
                                    explanation:"Будут удалены только записи истории отправок и ошибок. Расписания, тексты сообщений и счётчики успешных отправок останутся без изменений.")
                            } label: {
                                Label("Очистить журнал",systemImage:"trash")
                                    .font(.system(size:11,weight:.medium))
                                    .foregroundStyle(Palette.red)
                            }
                            .buttonStyle(HubInteractiveButtonStyle(treatment:.bordered))
                            .disabled(model.loading)
                        }
                    }
                    .padding(16)
                    .background(Palette.panel,in:RoundedRectangle(cornerRadius:12))
                }
                if let error=model.error {
                    Label(error,systemImage:"exclamationmark.triangle")
                        .font(.system(size:11.5)).foregroundStyle(Palette.red)
                        .fixedSize(horizontal:false,vertical:true)
                } else if let notice=model.notice {
                    Label(notice,systemImage:"checkmark.circle")
                        .font(.system(size:11.5)).foregroundStyle(Palette.online)
                        .fixedSize(horizontal:false,vertical:true)
                }
            }
            .padding(24)
        }
        .background(Palette.background)
        .task {
            // SwiftUI cancels this loop on tab disappearance. Poll faster while
            // a delivery is running so its final status appears automatically.
            while !Task.isCancelled {
                await model.refresh()
                let active = !model.busyTask.isEmpty || model.tasks.contains {
                    $0.status == "checking" || $0.status == "sending" || $0.status == "verifying"
                }
                try? await Task.sleep(for: .seconds(active ? 2 : 5))
            }
        }
        .confirmationDialog(confirmation?.title ?? "Подтвердить действие",isPresented:Binding(
            get:{confirmation != nil},set:{if !$0 {confirmation=nil}}
        )) {
            if let confirmation {
                Button(confirmation.action=="remove" ? "Удалить расписание" :
                       confirmation.action=="clear_history" ? "Очистить журнал" :
                       confirmation.action=="confirm_received" ? "Подтвердить вручную · без Send" :
                       "Отправить сообщение сейчас",
                       role: (confirmation.action=="remove" || confirmation.action=="clear_history") ? .destructive : nil) {
                    let action=confirmation.action,id=confirmation.id
                    self.confirmation=nil
                    Task {_ = await model.execute(action,values:action=="clear_history" ? [:] : ["id":id])}
                }
            }
            Button("Отмена",role:.cancel){confirmation=nil}
        } message: {
            Text(confirmation?.explanation ?? "")
        }
    }

    private func resetForm() {
        editingTaskID=nil
        url=""
        message=""
        interval="30"
        intervalUnit="minutes"
        scheduleMode="interval"
        runAt=Date().addingTimeInterval(3600)
        timeZoneID=TimeZone.current.identifier
        localTime="10:00"
        weekdays=[1,2,3,4,5]
        hasEndDate=false
        endDate=Date().addingTimeInterval(30*86400)
        delaySeconds="30"
        maxContinuations="20"
    }
    private func edit(_ task:ScheduledChatMessage) {
        editingTaskID=task.id
        url=task.url
        message=task.message
        scheduleMode=task.schedule_mode ?? "interval"
        if let value=task.run_at,let d=ISO8601DateFormatter().date(from:value){runAt=d}
        timeZoneID=task.time_zone ?? TimeZone.current.identifier
        localTime=task.local_time ?? "10:00"
        weekdays=Set(task.weekdays ?? [1,2,3,4,5])
        hasEndDate=task.end_at != nil
        if let value=task.end_at,let d=ISO8601DateFormatter().date(from:value){endDate=d}
        delaySeconds=String(task.delay_seconds ?? 30)
        maxContinuations=String(task.max_continuations ?? 20)
        if task.interval_seconds % 86400 == 0 {
            interval=String(task.interval_seconds / 86400)
            intervalUnit="days"
        } else if task.interval_seconds % 3600 == 0 {
            interval=String(task.interval_seconds / 3600)
            intervalUnit="hours"
        } else {
            interval=String(task.interval_seconds / 60)
            intervalUnit="minutes"
        }
    }
    private func deliveryStageName(_ stage:String)->String {
        switch stage {
        case "claimed":return "получено задание"
        case "tab_ready":return "открыта вкладка"
        case "conversation_ready":return "проверен разговор"
        case "composer_ready":return "готов редактор"
        case "text_inserted":return "введён текст"
        case "send_clicked":return "нажата отправка"
        case "message_observed":return "сообщение появилось в чате"
        case "verifying":return "ожидание подтверждения без повторной отправки"
        case "verification-expired":return "неоднозначный результат"
        default:return "проверка"
        }
    }

    private func scheduleCard(_ task:ScheduledChatMessage)->some View {
        VStack(alignment:.leading,spacing:13) {
            HStack(alignment:.center,spacing:10) {
                Image(systemName:"clock.arrow.circlepath")
                    .foregroundStyle(Palette.accent)
                    .frame(width:32,height:32)
                    .background(Palette.accentSoft,in:RoundedRectangle(cornerRadius:9))
                VStack(alignment:.leading,spacing:4) {
                    Text(task.url)
                        .font(.system(size:11,design:.monospaced)).foregroundStyle(Palette.ink)
                        .lineLimit(1).textSelection(.enabled)
                    Text(scheduleDescription(task))
                        .font(.system(size:11)).foregroundStyle(Palette.quiet)
                }
                Spacer(minLength:8)
                HStack(spacing:7) {
                    Circle().fill(stateColor(task)).frame(width:7,height:7)
                    Text(stateDescription(task))
                        .font(.system(size:11,weight:.semibold)).foregroundStyle(stateColor(task))
                }
            }
            if let conversation=model.conversations[task.url] {
                HStack(spacing:6) {
                    Image(systemName:conversation.blocked ? "lock.shield" : "point.3.connected.trianglepath.dotted")
                        .font(.system(size:10.5))
                    Text("Состояние разговора: " + conversationDescription(conversation.state))
                        .font(.system(size:10.5,weight:.medium))
                }
                .foregroundStyle(conversation.state=="UNKNOWN" ? Palette.warning : Palette.muted)
                .accessibilityLabel("Очередь этого разговора: " + conversationDescription(conversation.state))
            }
            Text(task.message)
                .font(.system(size:12)).foregroundStyle(Palette.muted)
                .lineLimit(3)
                .frame(maxWidth:.infinity,alignment:.leading)
                .padding(11)
                .background(Palette.inner,in:RoundedRectangle(cornerRadius:9))
            HStack(spacing:12) {
                VStack(alignment:.leading,spacing:3) {
                    Text("Следующая попытка")
                        .font(.system(size:10.5)).foregroundStyle(Palette.quiet)
                    Text(task.schedule_mode=="after_response" && task.next_at==nil && task.enabled ?
                         "Ожидаем завершения ответа" : displayDate(task.next_at))
                        .font(.system(size:11,weight:.medium)).foregroundStyle(Palette.ink)
                }
                Spacer()
                VStack(alignment:.trailing,spacing:3) {
                    Text("Подтверждено в чате")
                        .font(.system(size:10.5)).foregroundStyle(Palette.quiet)
                    Text(String(task.delivery_count))
                        .font(.system(size:11,weight:.medium)).foregroundStyle(Palette.ink)
                }
            }
            if task.status=="verifying", let proof=task.verification {
                Label("Дополнительная проверка №\(proof.checks) · до \(displayDate(proof.deadlineAt)). Send повторно не нажимается.",
                      systemImage:"clock.arrow.circlepath")
                    .font(.system(size:10.5)).foregroundStyle(Palette.accent)
                    .fixedSize(horizontal:false,vertical:true)
                if let evidence=proof.lastEvidence {
                    Text(evidenceDescription(evidence))
                        .font(.system(size:10.5)).foregroundStyle(Palette.muted)
                        .fixedSize(horizontal:false,vertical:true)
                }
            }
            if task.status=="unknown" {
                Label("После неопределённого результата новая отправка заблокирована. Сначала проверь существующую попытку.",
                      systemImage:"hand.raised.fill")
                    .font(.system(size:11,weight:.medium))
                    .foregroundStyle(Palette.warning)
                    .fixedSize(horizontal:false,vertical:true)
                if let receipt=task.verification {
                    Button {
                        Task {_ = await model.execute("recheck_unknown",values:["id":task.id])}
                    } label: {
                        Label("Проверить ещё раз · без отправки",systemImage:"checkmark.shield")
                            .font(.system(size:11.5,weight:.semibold))
                    }
                    .buttonStyle(HubInteractiveButtonStyle(treatment:.bordered))
                    .disabled(model.loading)
                    if let evidence=receipt.lastEvidence {
                        DisclosureGroup("Диагностика последней попытки") {
                            Text(evidenceDescription(evidence))
                                .font(.system(size:10.5))
                                .foregroundStyle(Palette.muted)
                                .fixedSize(horizontal:false,vertical:true)
                        }
                        .font(.system(size:10.5,weight:.medium))
                        .foregroundStyle(Palette.quiet)
                    }
                } else {
                    Text("Сохранённой квитанции нет. Проверь чат вручную; автоматического повтора не будет.")
                        .font(.system(size:10.5)).foregroundStyle(Palette.muted)
                }
                Button {
                    confirmation=Confirmation(id:task.id,action:"confirm_received",
                        title:"Подтвердить отправку вручную?",
                        explanation:"Используй только если лично видишь новое сообщение в указанном чате ChatGPT. McpGo отметит попытку как подтверждённую вручную, но НЕ отправит текст повторно и оставит расписание на паузе.")
                } label: {
                    Label("Сообщение уже в чате · подтвердить вручную",systemImage:"checkmark.seal")
                        .font(.system(size:11.5,weight:.medium))
                }
                .buttonStyle(HubInteractiveButtonStyle(treatment:.bordered))
                .disabled(model.loading)
            }
            if (task.status=="sending" || task.status=="verifying"), let stage=task.delivery_stage {
                Label("Этап: \(deliveryStageName(stage)) · это не подтверждение завершения ответа ChatGPT",systemImage:"arrow.triangle.2.circlepath")
                    .font(.system(size:10.5)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal:false,vertical:true)
            }
            if !task.last_error.isEmpty {
                Label(task.last_error,systemImage:"exclamationmark.triangle")
                    .font(.system(size:11)).foregroundStyle(Palette.warning)
                    .fixedSize(horizontal:false,vertical:true)
            }
            if let status=model.preflightResults[task.id] {
                Text(status).font(.system(size:10.5)).foregroundStyle(Palette.muted)
                    .fixedSize(horizontal:false,vertical:true)
            }
            HStack(spacing:10) {
                Button {
                    Task { await model.preview(task.id) }
                } label: {
                    Label("Проверить без отправки",systemImage:"checkmark.shield")
                        .font(.system(size:11)).foregroundStyle(Palette.ink)
                }
                .buttonStyle(HubInteractiveButtonStyle(treatment:.bordered))
                .disabled(model.loading || task.status=="sending" || task.status=="checking" || task.status=="verifying")
                Button {
                    Task {_ = await model.execute(task.enabled ? "pause" : "start",values:["id":task.id])}
                } label: {
                    Label(task.enabled ? "Пауза" : "Включить",systemImage:task.enabled ? "pause.fill" : "play.fill")
                        .font(.system(size:11.5,weight:.semibold))
                        .foregroundStyle(task.enabled ? Palette.ink : Color(hex:0x121526))
                        .padding(.horizontal,12).frame(height:35)
                        .background(task.enabled ? Palette.inner : Palette.accent,in:RoundedRectangle(cornerRadius:9))
                }
                .buttonStyle(HubInteractiveButtonStyle())
                .disabled(!task.enabled && (task.manual_once==true && task.status=="scheduled"))
                Button {
                    confirmation=Confirmation(id:task.id,action:"send_once",
                        title:"Отправить сообщение сейчас?",
                        explanation:"Расширение Playwright MCP проверит указанный чат. Если агент свободен, сообщение будет отправлено. При неопределённом результате автоматические повторы запрещены.")
                } label: {
                    Label("Отправить сейчас",systemImage:"paperplane")
                        .font(.system(size:11)).foregroundStyle(Palette.ink)
                }
                .buttonStyle(HubInteractiveButtonStyle(treatment:.bordered))
                .disabled(task.status=="unknown" || task.status=="sending" || task.status=="checking" || task.status=="verifying" || task.manual_once==true)
                Spacer()
                Button { edit(task) } label: {
                    Label("Изменить",systemImage:"pencil")
                        .font(.system(size:11)).foregroundStyle(Palette.ink)
                }.buttonStyle(HubInteractiveButtonStyle(treatment:.bordered))
                Button {
                    confirmation=Confirmation(id:task.id,action:"remove",
                        title:"Удалить расписание?",
                        explanation:"Расписание и его текст будут удалены. История попыток сохранится локально.")
                } label: {
                    Label("Удалить",systemImage:"trash")
                        .font(.system(size:11)).foregroundStyle(Palette.red)
                }.buttonStyle(HubInteractiveButtonStyle(treatment:.bordered))
            }
            .disabled(model.loading || model.busyTask==task.id || task.status=="verifying")
        }
        .padding(16)
        .background(Palette.panel,in:RoundedRectangle(cornerRadius:13))
        .overlay(RoundedRectangle(cornerRadius:13).stroke(Palette.stroke))
    }
}
