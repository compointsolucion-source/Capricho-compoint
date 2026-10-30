package mx.com.compoint.check.terminal;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KioscoPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
