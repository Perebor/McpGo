/** Declarative tool catalog views for MCP clients.
 * The upstream server keeps its complete tool set. Names not advertised are
 * not removed from the authorization/ownership checks in the proxy, so a
 * cached catalog never causes an accidental privilege or ownership change.
 * Profile changes take effect on proxy restart, not during a conversation.
 */
const BASE=new Set([
 'browser_tabs','browser_navigate','browser_navigate_back','browser_click',
 'browser_type','browser_press_key','browser_wait_for','browser_snapshot',
 'browser_find','browser_hover','browser_select_option','browser_file_upload',
 'browser_handle_dialog',
 'mcpgo_inspect_page','mcpgo_workspace','mcpgo_tab_action',
 'mcpgo_tab_handle','mcpgo_tab_lease','mcpgo_browser_status',
 'mcpgo_agent_status','mcpgo_action_status'
]);
const VISION=new Set(['browser_take_screenshot','browser_drag','browser_mouse_move',
 'browser_mouse_click_xy','browser_mouse_drag','browser_mouse_wheel',
 'browser_mouse_down','browser_mouse_up','browser_resize']);
const DIAGNOSTIC=new Set(['browser_console_messages','browser_network_requests',
 'browser_network_request','browser_evaluate','browser_evaluate_script',
 'browser_start_tracing','browser_stop_tracing','browser_trace',
 'browser_generate_locator','browser_get_locators']);
const PROFILES=new Set(['full','core','vision','diagnostics']);
export function validateToolProfile(value='full'){
 if(typeof value!=='string'||!PROFILES.has(value))throw Error('Invalid MCPGO_BROWSER_TOOL_PROFILE');
 return value;
}
export function visibleTool(name,profile='full'){
 const mode=validateToolProfile(profile);
 if(mode==='full')return true;
 if(BASE.has(name))return true;
 return mode==='vision'?VISION.has(name):mode==='diagnostics'&&(VISION.has(name)||DIAGNOSTIC.has(name));
}
export function filterTools(tools,profile='full'){
 validateToolProfile(profile);
 if(!Array.isArray(tools))throw Error('Invalid MCP tools list');
 return tools.filter(t=>visibleTool(t?.name,profile));
}
export const profileNames=Object.freeze([...PROFILES]);
