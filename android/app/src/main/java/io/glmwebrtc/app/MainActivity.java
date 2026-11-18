package io.glmwebrtc.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins (no npm packaging): battery + foreground call service.
        // MUST precede super.onCreate: it consumes bridgeBuilder to create the
        // bridge, so registering after silently drops the plugin (every System
        // call then no-ops: no service, no battery check, no audio routing).
        registerPlugin(SystemPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
