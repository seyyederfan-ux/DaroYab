package ir.daroyab.app;

import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSession;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

@CapacitorPlugin(name = "SslBypass")
public class SslBypassPlugin extends Plugin {

    private OkHttpClient client;

    private OkHttpClient getClient() {
        if (client == null) {
            TrustManager[] trustAll = new TrustManager[]{
                new X509TrustManager() {
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                    public void checkClientTrusted(X509Certificate[] c, String a) {}
                    public void checkServerTrusted(X509Certificate[] c, String a) {}
                }
            };
            try {
                SSLContext sc = SSLContext.getInstance("TLS");
                sc.init(null, trustAll, new SecureRandom());
                client = new OkHttpClient.Builder()
                        .sslSocketFactory(sc.getSocketFactory(), (X509TrustManager) trustAll[0])
                        .hostnameVerifier(new HostnameVerifier() {
                            public boolean verify(String h, SSLSession s) { return true; }
                        })
                        .connectTimeout(20, TimeUnit.SECONDS)
                        .readTimeout(20, TimeUnit.SECONDS)
                        .followRedirects(true)
                        .build();
            } catch (Exception e) {
                client = new OkHttpClient.Builder().build();
            }
        }
        return client;
    }

    @PluginMethod
    public void fetchText(PluginCall call) {
        String url = call.getString("url");
        if (url == null) { call.reject("url required"); return; }
        // Safety: only allow the TTAC host (broad SSL bypass is dangerous)
        if (!url.contains("irc.fda.gov.ir")) { call.reject("host not allowed"); return; }
        try {
            Request req = new Request.Builder().url(url)
                    .header("User-Agent", "Mozilla/5.0 (Linux; Android " + Build.VERSION.RELEASE + ") AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36")
                    .build();
            Response resp = getClient().newCall(req).execute();
            String body = resp.body() != null ? resp.body().string() : "";
            JSObject ret = new JSObject();
            ret.put("status", resp.code());
            ret.put("data", body);
            resp.close();
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("fetch failed: " + e.getMessage());
        }
    }
}
