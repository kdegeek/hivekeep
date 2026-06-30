#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Size, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
const QUICK_PANEL_LABEL: &str = "quick-panel";
const QUICK_PANEL_WIDTH: f64 = 390.0;
const QUICK_PANEL_HEIGHT: f64 = 620.0;
const TRAY_BLUR_SUPPRESS_TOGGLE_MS: u64 = 300;
const WINDOW_STATE_FILE: &str = "window-state.txt";
const MIN_MAIN_WINDOW_WIDTH: u32 = 960;
const MIN_MAIN_WINDOW_HEIGHT: u32 = 640;
const OPEN_MAIN_MENU_ID: &str = "open-main";
const QUICK_PANEL_MENU_ID: &str = "quick-panel";
const SETTINGS_MENU_ID: &str = "settings";
const QUIT_MENU_ID: &str = "quit";
const OPEN_SETTINGS_EVENT: &str = "hivekeep-open-settings";
// Whether the main window currently has OS focus. Emitted instead of relying
// on the webview's document.visibilityState, which is unreliable once the
// window is hidden to the tray rather than just backgrounded — the frontend
// uses this to decide whether a new notification should also fire a native
// OS toast (only when the user isn't already looking at the app).
const WINDOW_FOCUS_EVENT: &str = "hivekeep-window-focus";

#[derive(Default)]
struct QuickPanelState {
    last_blur_hide: Mutex<Option<Instant>>,
}

#[tauri::command]
fn hide_quick_panel(app: AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window(QUICK_PANEL_LABEL) {
        panel.hide().map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // Must be registered before any other plugin (Tauri requirement): a second
        // launch attempt is redirected here instead of opening a second window, so
        // Hivekeep stays a true single-instance tray app.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            open_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(QuickPanelState::default())
        .invoke_handler(tauri::generate_handler![hide_quick_panel])
        .setup(|app| {
            if let Some(main_window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                restore_main_window_placement(app.handle(), &main_window);
            }
            build_quick_panel(app.handle())?;
            build_tray_icon(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match window.label() {
            QUICK_PANEL_LABEL => {
                if let WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                    if let Some(state) = window.try_state::<QuickPanelState>() {
                        if let Ok(mut last_blur_hide) = state.last_blur_hide.lock() {
                            *last_blur_hide = Some(Instant::now());
                        }
                    }
                }
            }
            MAIN_WINDOW_LABEL => {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    save_main_window_placement(window);
                    api.prevent_close();
                    let _ = window.hide();
                }
                if let WindowEvent::Focused(is_focused) = event {
                    let _ = window.emit(WINDOW_FOCUS_EVENT, *is_focused);
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running Hivekeep");
}

fn build_quick_panel(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(
        app,
        QUICK_PANEL_LABEL,
        WebviewUrl::App("index.html?surface=mobile&quickPanel=1".into()),
    )
    .title("Hivekeep Quick Panel")
    .inner_size(QUICK_PANEL_WIDTH, QUICK_PANEL_HEIGHT)
    .min_inner_size(320.0, 420.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(true)
    .focused(false)
    .visible(false)
    .build()
}

fn build_tray_icon(app: &tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(OPEN_MAIN_MENU_ID, "Open Hivekeep")
        .text(QUICK_PANEL_MENU_ID, "Quick Panel")
        .text(SETTINGS_MENU_ID, "Settings / Server URL")
        .separator()
        .text(QUIT_MENU_ID, "Quit")
        .build()?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("Hivekeep")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_MAIN_MENU_ID => open_main_window(app),
            QUICK_PANEL_MENU_ID => toggle_quick_panel_at_cursor(app),
            SETTINGS_MENU_ID => open_settings(app),
            QUIT_MENU_ID => {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    save_main_window_placement(&window.as_ref().window());
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let TrayIconEvent::Click {
                position,
                button: MouseButton::Left,
                button_state: MouseButtonState::Down,
                ..
            } = event
            else {
                return;
            };

            toggle_quick_panel(tray.app_handle(), position);
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

fn open_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn open_settings(app: &AppHandle) {
    open_main_window(app);
    let _ = app.emit_to(MAIN_WINDOW_LABEL, OPEN_SETTINGS_EVENT, "general");
}

fn toggle_quick_panel_at_cursor(app: &AppHandle) {
    if let Ok(position) = app.cursor_position() {
        toggle_quick_panel(app, position);
    }
}

fn toggle_quick_panel(app: &AppHandle, anchor: PhysicalPosition<f64>) {
    let Some(panel) = app.get_webview_window(QUICK_PANEL_LABEL) else {
        return;
    };

    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }

    if recently_hidden_by_blur(app) {
        return;
    }

    let position = anchored_panel_position(app, anchor);
    let _ = panel.set_position(position);
    let _ = panel.show();
    let _ = panel.set_focus();
}

fn recently_hidden_by_blur(app: &AppHandle) -> bool {
    let state = app.state::<QuickPanelState>();
    let Ok(last_blur_hide) = state.last_blur_hide.lock() else {
        return false;
    };
    last_blur_hide
        .map(|hidden_at| hidden_at.elapsed() < Duration::from_millis(TRAY_BLUR_SUPPRESS_TOGGLE_MS))
        .unwrap_or(false)
}

fn anchored_panel_position(
    app: &AppHandle,
    anchor: PhysicalPosition<f64>,
) -> PhysicalPosition<i32> {
    let margin = 12.0;
    let mut x = anchor.x - QUICK_PANEL_WIDTH + 16.0;
    let mut y = anchor.y - QUICK_PANEL_HEIGHT - margin;

    if let Some((left, top, right, bottom)) = work_area_containing(app, anchor.x, anchor.y) {
        if y < top {
            y = anchor.y + margin;
        }

        // Guard against work areas smaller than the panel: clamp() panics when min > max.
        let min_x = left + margin;
        let max_x = right - QUICK_PANEL_WIDTH - margin;
        if min_x <= max_x {
            x = x.clamp(min_x, max_x);
        } else {
            x = min_x;
        }

        let min_y = top + margin;
        let max_y = bottom - QUICK_PANEL_HEIGHT - margin;
        if min_y <= max_y {
            y = y.clamp(min_y, max_y);
        } else {
            y = min_y;
        }
    }

    PhysicalPosition::new(x.round() as i32, y.round() as i32)
}

fn work_area_containing(app: &AppHandle, x: f64, y: f64) -> Option<(f64, f64, f64, f64)> {
    app.available_monitors()
        .ok()?
        .into_iter()
        .find_map(|monitor| {
            let work_area = monitor.work_area();
            let left = work_area.position.x as f64;
            let top = work_area.position.y as f64;
            let right = left + work_area.size.width as f64;
            let bottom = top + work_area.size.height as f64;

            (x >= left && x <= right && y >= top && y <= bottom)
                .then_some((left, top, right, bottom))
        })
}

#[derive(Clone, Copy)]
struct MainWindowPlacement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn restore_main_window_placement(app: &AppHandle, window: &WebviewWindow) {
    let Some(placement) = load_main_window_placement(app) else {
        return;
    };

    let _ = window.set_position(PhysicalPosition::new(placement.x, placement.y));
    let _ = window.set_size(Size::Physical(PhysicalSize::new(
        placement.width,
        placement.height,
    )));
}

fn save_main_window_placement(window: &Window) {
    // Skip saving while minimized/maximized: those report off-screen coordinates
    // (e.g. (-32000, -32000)) or maximized dimensions that would corrupt the
    // restored default placement on next launch.
    if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return;
    }
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Some(path) = window_state_path(window.app_handle()) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let placement = format!(
        "{},{},{},{}",
        position.x, position.y, size.width, size.height
    );
    let _ = fs::write(path, placement);
}

fn load_main_window_placement(app: &AppHandle) -> Option<MainWindowPlacement> {
    let path = window_state_path(app)?;
    let contents = fs::read_to_string(path).ok()?;
    let mut parts = contents.trim().split(',');

    let placement = MainWindowPlacement {
        x: parts.next()?.parse().ok()?,
        y: parts.next()?.parse().ok()?,
        width: parts.next()?.parse().ok()?,
        height: parts.next()?.parse().ok()?,
    };

    if parts.next().is_some()
        || placement.width < MIN_MAIN_WINDOW_WIDTH
        || placement.height < MIN_MAIN_WINDOW_HEIGHT
    {
        return None;
    }

    // Discard stale placements that no longer intersect any connected monitor
    // (e.g. the window was last shown on an external display that is now gone),
    // otherwise restoring would leave the window invisible and inaccessible.
    if !placement_is_visible(app, &placement) {
        return None;
    }

    Some(placement)
}

fn placement_is_visible(app: &AppHandle, placement: &MainWindowPlacement) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        // If monitor enumeration fails, fall back to trusting the saved placement.
        return true;
    };

    monitors.into_iter().any(|monitor| {
        let area = monitor.work_area();
        let left = area.position.x;
        let top = area.position.y;
        let right = left + area.size.width as i32;
        let bottom = top + area.size.height as i32;

        placement.x >= left && placement.x < right && placement.y >= top && placement.y < bottom
    })
}

fn window_state_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(WINDOW_STATE_FILE))
}
