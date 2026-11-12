package com.vibetv.app;

import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins (platform/android/ in the web app calls them).
        registerPlugin(VibeDevicePlugin.class);
        registerPlugin(VibeFilesPlugin.class);
        registerPlugin(VibeHttpPlugin.class);
        registerPlugin(VibePlayerPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // Keys of a TV remote that a web page is never told about: Menu, channel up / down, the
    // play keys, and OK being held down. They are handed to the page by name (VibeDevicePlugin "key" event).
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // OK held down: the page is told once ("holdOk"), and never sees the repeats.
        int code = event.getKeyCode();
        if ((code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER)
                && event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() > 0 && getBridge() != null) {
            if (event.getRepeatCount() == 1) {
                PluginHandle handle = getBridge().getPlugin("VibeDevice");
                if (handle != null) ((VibeDevicePlugin) handle.getInstance()).remoteKey("holdOk");
            }
            return true;
        }
        String name = null;
        switch (event.getKeyCode()) {
            case KeyEvent.KEYCODE_MENU: name = "menu"; break;
            case KeyEvent.KEYCODE_CHANNEL_UP: case KeyEvent.KEYCODE_MEDIA_NEXT: name = "next"; break;
            case KeyEvent.KEYCODE_CHANNEL_DOWN: case KeyEvent.KEYCODE_MEDIA_PREVIOUS: name = "previous"; break;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: case KeyEvent.KEYCODE_MEDIA_PLAY: case KeyEvent.KEYCODE_MEDIA_PAUSE: name = "playPause"; break;
            default: break;
        }
        if (name == null || getBridge() == null) return super.dispatchKeyEvent(event);
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            PluginHandle handle = getBridge().getPlugin("VibeDevice");
            if (handle != null) ((VibeDevicePlugin) handle.getInstance()).remoteKey(name);
        }
        return true;
    }
}
