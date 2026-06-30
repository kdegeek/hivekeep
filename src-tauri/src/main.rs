#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use tauri::{
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

const QUICK_PANEL_LABEL: &str = "quick-panel";
const QUICK_PANEL_WIDTH: f64 = 390.0;
const QUICK_PANEL_HEIGHT: f64 = 620.0;
const TRAY_BLUR_SUPPRESS_TOGGLE_MS: u64 = 300;

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
        .manage(QuickPanelState::default())
        .invoke_handler(tauri::generate_handler![hide_quick_panel])
        .setup(|app| {
            build_quick_panel(app.handle())?;
            build_tray_icon(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == QUICK_PANEL_LABEL {
                if let WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                    if let Some(state) = window.try_state::<QuickPanelState>() {
                        if let Ok(mut last_blur_hide) = state.last_blur_hide.lock() {
                            *last_blur_hide = Some(Instant::now());
                        }
                    }
                }
            }
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
    let mut builder = TrayIconBuilder::new()
        .tooltip("Hivekeep")
        .show_menu_on_left_click(false)
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

        x = x.clamp(left + margin, right - QUICK_PANEL_WIDTH - margin);
        y = y.clamp(top + margin, bottom - QUICK_PANEL_HEIGHT - margin);
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
