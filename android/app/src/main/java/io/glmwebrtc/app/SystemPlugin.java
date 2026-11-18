package io.glmwebrtc.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.database.Cursor;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.ContactsContract;
import android.provider.Settings;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

// Local (non-npm) plugin: battery-exemption intents + foreground call service.
// Registered in MainActivity. JS lives in renderer/src/lib/system.ts.
@CapacitorPlugin(
    name = "System",
    permissions = {
        @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone"),
        @Permission(strings = { Manifest.permission.READ_CONTACTS }, alias = "contacts")
    }
)
public class SystemPlugin extends Plugin {

    private static final String CALL_CHANNEL = "fg_calls";
    private static final int NOTIF_ID = 1001;

    // ---- Battery exemption ----

    @PluginMethod
    public void isIgnoringBattery(PluginCall call) {
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        boolean ignoring = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        JSObject ret = new JSObject();
        ret.put("ignoring", ignoring);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + ctx.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    // ---- Microphone permission (runtime prompt before first call) ----

    @PluginMethod
    public void checkMic(PluginCall call) {
        boolean granted = getPermissionState("microphone") == PermissionState.GRANTED;
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestMic(PluginCall call) {
        requestPermissionForAlias("microphone", call, "micPermCallback");
    }

    @PermissionCallback
    private void micPermCallback(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
        } else {
            call.reject("Microphone permission denied — allow it in Android Settings → Apps → GLMWebrtc → Permissions, then dial again.");
        }
    }

    // ---- Proximity screen-off (ear sensor during calls) ----

    private PowerManager.WakeLock proximityLock;

    @PluginMethod
    public void proximityOn(PluginCall call) {
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (pm == null) {
                call.reject("no power service");
                return;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                    && !pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                call.reject("no proximity sensor");
                return;
            }
            if (proximityLock == null || !proximityLock.isHeld()) {
                proximityLock = pm.newWakeLock(
                        PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "GLMWebrtc:ProximityLock");
                proximityLock.acquire();
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void proximityOff(PluginCall call) {
        try {
            if (proximityLock != null) {
                try {
                    if (proximityLock.isHeld()) proximityLock.release();
                } catch (Exception ignored) {
                }
                proximityLock = null;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    // ---- System ringtones (looped MediaPlayer on the ring stream) ----

    private MediaPlayer ringPlayer;

    @PluginMethod
    public void listRingtones(PluginCall call) {
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
        Cursor c = null;
        try {
            RingtoneManager rm = new RingtoneManager(getContext());
            rm.setType(RingtoneManager.TYPE_RINGTONE);
            c = rm.getCursor();
            int count = 0;
            while (c.moveToNext() && count < 200) {
                android.net.Uri uri = rm.getRingtoneUri(c.getPosition());
                String title = c.getString(RingtoneManager.TITLE_COLUMN_INDEX);
                JSObject o = new JSObject();
                o.put("title", title != null ? title : "Unknown");
                o.put("uri", uri.toString());
                arr.put(o);
                count++;
            }
            JSObject ret = new JSObject();
            ret.put("ringtones", arr);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        } finally {
            if (c != null) c.close();
        }
    }

    @PluginMethod
    public void playRingtone(PluginCall call) {
        try {
            stopRingtoneInternal();
            String uriStr = call.getString("uri");
            if (uriStr == null || uriStr.isEmpty()) {
                call.reject("missing uri");
                return;
            }
            MediaPlayer mp = new MediaPlayer();
            mp.setDataSource(getContext(), android.net.Uri.parse(uriStr));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                mp.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
            } else {
                mp.setAudioStreamType(AudioManager.STREAM_RING);
            }
            mp.setLooping(true);
            mp.prepare();
            mp.start();
            ringPlayer = mp;
            call.resolve();
        } catch (Exception e) {
            stopRingtoneInternal();
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void stopRingtone(PluginCall call) {
        stopRingtoneInternal();
        call.resolve();
    }

    private void stopRingtoneInternal() {
        try {
            if (ringPlayer != null) {
                try {
                    if (ringPlayer.isPlaying()) ringPlayer.stop();
                } catch (Exception ignored) {
                }
                try {
                    ringPlayer.release();
                } catch (Exception ignored) {
                }
                ringPlayer = null;
            }
        } catch (Exception ignored) {
        }
    }

    // ---- Phone contacts (READ_CONTACTS runtime prompt) ----

    @PluginMethod
    public void checkContacts(PluginCall call) {
        boolean granted = getPermissionState("contacts") == PermissionState.GRANTED;
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestContacts(PluginCall call) {
        requestPermissionForAlias("contacts", call, "contactsPermCallback");
    }

    @PermissionCallback
    private void contactsPermCallback(PluginCall call) {
        if (getPermissionState("contacts") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
        } else {
            call.reject("Contacts permission denied — allow it in Android Settings → Apps → GLMWebrtc → Permissions.");
        }
    }

    @PluginMethod
    public void listContacts(PluginCall call) {
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            call.reject("contacts permission not granted");
            return;
        }
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
        Cursor c = null;
        try {
            c = getContext().getContentResolver().query(
                    ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    new String[]{
                            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                            ContactsContract.CommonDataKinds.Phone.NUMBER
                    },
                    null, null,
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC");
            int count = 0;
            if (c != null) {
                int nameIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME);
                int numIdx = c.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);
                while (c.moveToNext() && count < 2000) {
                    String number = c.getString(numIdx);
                    if (number == null || number.trim().isEmpty()) continue;
                    String name = c.getString(nameIdx);
                    JSObject o = new JSObject();
                    o.put("name", name != null && !name.isEmpty() ? name : number);
                    o.put("number", number);
                    arr.put(o);
                    count++;
                }
            }
            JSObject ret = new JSObject();
            ret.put("contacts", arr);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(e.getMessage());
        } finally {
            if (c != null) c.close();
        }
    }

    // ---- Call audio routing (earpiece vs speaker) ----

    // NOTE: setSpeakerphoneOn() alone only steers the voice-call stream, while
    // WebView <audio> playback rides the media path — so on its own the voice
    // stays on the loudspeaker. The real switch is setCommunicationDevice()
    // (API 31+); legacy speakerphone toggle remains as the pre-31 fallback.
    // mode: "ring" (loud incoming ring), "comm" (in-call, speaker flag honored),
    // anything else → normal mode, speaker off. Needs MODIFY_AUDIO_SETTINGS.
    @PluginMethod
    @SuppressWarnings("deprecation") // setMode/speakerphone still required as fallback + mic path
    public void audioRoute(PluginCall call) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) {
                call.reject("no audio service");
                return;
            }
            String mode = call.getString("mode", "normal");
            boolean speaker = Boolean.TRUE.equals(call.getBoolean("speaker", false));
            if ("ring".equals(mode)) {
                clearCommDevice(am);
                am.setMode(AudioManager.MODE_RINGTONE);
                am.setSpeakerphoneOn(true);
            } else if ("comm".equals(mode)) {
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                if (!setCommDevice(am, speaker)) {
                    am.setSpeakerphoneOn(speaker);
                }
            } else {
                clearCommDevice(am);
                am.setSpeakerphoneOn(false);
                am.setMode(AudioManager.MODE_NORMAL);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    // Returns true when the modern routing API handled it.
    private boolean setCommDevice(AudioManager am, boolean speaker) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false;
        try {
            int want = speaker
                    ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                    : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
            for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                if (d.getType() == want) {
                    return am.setCommunicationDevice(d);
                }
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private void clearCommDevice(AudioManager am) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        try {
            am.clearCommunicationDevice();
        } catch (Exception ignored) {
        }
    }

    // ---- Foreground call service ----

    @PluginMethod
    public void startCallService(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent i = new Intent(ctx, CallService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void stopCallService(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), CallService.class));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    // ---- The service itself ----

    public static class CallService extends Service {
        private PowerManager.WakeLock wakeLock;
        private WifiManager.WifiLock wifiLock;

        @Override
        public void onCreate() {
            super.onCreate();
            // Without these, screen-off sleep kills the SIP socket even though the
            // service keeps the process alive (Asterisk then logs "reset by peer").
            // Held only while registered; released in onDestroy (logout/unregister).
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GLMWebrtc:CallLock");
                    wakeLock.acquire();
                }
            } catch (Exception ignored) {
            }
            try {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "GLMWebrtc:WifiLock");
                    wifiLock.acquire();
                }
            } catch (Exception ignored) {
            }
        }

        @Override
        public void onDestroy() {
            try {
                if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            } catch (Exception ignored) {
            }
            try {
                if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
            } catch (Exception ignored) {
            }
            super.onDestroy();
        }

        @Override
        public int onStartCommand(Intent intent, int flags, int startId) {
            // Never let the service take the process down: any failure here
            // (restricted FGS type, missing permission) must degrade, not crash.
            try {
                startForegroundInternal();
            } catch (Exception e) {
                try {
                    stopSelf();
                } catch (Exception ignored) {
                }
            }
            return START_STICKY;
        }

        private void startForegroundInternal() {
            NotificationManager nm =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm != null) {
                NotificationChannel ch = new NotificationChannel(
                        CALL_CHANNEL, "Calls", NotificationManager.IMPORTANCE_LOW);
                nm.createNotificationChannel(ch);
            }

            Intent open = new Intent(this, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Notification notif = new NotificationCompat.Builder(this, CALL_CHANNEL)
                    .setContentTitle("GLMWebrtc — listening for calls")
                    .setContentText("Tap to open")
                    .setSmallIcon(android.R.drawable.sym_call_incoming)
                    .setContentIntent(pi)
                    .setOngoing(true)
                    .build();

            // specialUse: no runtime use-case gating (unlike phoneCall, which
            // throws on modern Android outside Telecom-managed calls).
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIF_ID, notif);
            }
        }

        @Override
        public IBinder onBind(Intent intent) {
            return null;
        }
    }
}
