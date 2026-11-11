package com.vibetv.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The app's own plugins (platform/android/ in the web app calls them).
        registerPlugin(VibeDevicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
