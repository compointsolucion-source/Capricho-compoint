package mx.com.compoint.check.terminal;

import android.app.Activity;
import android.view.View;
import android.view.WindowManager;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Modo kiosco de la tableta: pantalla siempre encendida, pantalla completa y app fijada
// (no se puede salir a otras apps hasta escribir el PIN de salida en la terminal).
@CapacitorPlugin(name = "Kiosco")
public class KioscoPlugin extends Plugin {

    @PluginMethod
    public void activar(PluginCall call) {
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            a.getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
            try { a.startLockTask(); } catch (Exception e) { /* la tableta no permite fijar apps */ }
            call.resolve();
        });
    }

    @PluginMethod
    public void salir(PluginCall call) {
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            a.getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            try { a.stopLockTask(); } catch (Exception e) { /* no estaba fijada */ }
            call.resolve();
        });
    }
}
