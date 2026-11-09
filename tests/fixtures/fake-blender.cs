using System;
using System.IO;
using System.Text;

public static class FakeBlender {
    public static int Main(string[] args) {
        try {
            if (args.Length > 0 && args[0] == "--version") {
                Console.WriteLine("Blender 5.2.3 LTS");
                return 0;
            }
            string specPath = null;
            for (int i = 0; i < args.Length - 1; i++) {
                if (args[i] == "--") { specPath = args[i + 1]; break; }
            }
            if (specPath == null) {
                Console.Error.WriteLine("fake blender: missing -- specPath");
                return 2;
            }
            string outputDirectory = Path.Combine(
                Path.GetDirectoryName(specPath), "artifact");
            string mode = Environment.GetEnvironmentVariable("FILMIE_FAKE_BLENDER_MODE");
            if (mode == "missing") {
                Console.Error.WriteLine(
                    "FILMIE_FAKE_CRASH: simulated access violation (no frames written)");
                return 3;
            }
            string d = Environment.GetEnvironmentVariable("FILMIE_FAKE_DURATION_FRAMES");
            int durationFrames = d == null ? 3 : int.Parse(d);
            string w = Environment.GetEnvironmentVariable("FILMIE_FAKE_WIDTH");
            int width = w == null ? 1280 : int.Parse(w);
            string h = Environment.GetEnvironmentVariable("FILMIE_FAKE_HEIGHT");
            int height = h == null ? 720 : int.Parse(h);
            string framesDir = Path.Combine(outputDirectory, "frames");
            Directory.CreateDirectory(framesDir);
            for (int f = 1; f <= durationFrames; f++) {
                string path = Path.Combine(
                    framesDir, "frame_" + f.ToString("D6") + ".png");
                File.WriteAllBytes(path, MakePng(width, height));
            }
            File.WriteAllText(
                Path.Combine(outputDirectory, "scene.blend"), "fake blend scene");
            File.WriteAllText(
                Path.Combine(outputDirectory, "worker-result.json"),
                "{\"status\":\"success\",\"frameCount\":" + durationFrames + "}");
            Console.Error.WriteLine(
                "FILMIE_FAKE_CRASH: simulated access violation in ig11icd64.dll after writing frames");
            return 3;
        } catch (Exception e) {
            Console.Error.WriteLine("fake blender error: " + e.Message);
            return 2;
        }
    }

    static byte[] MakePng(int width, int height) {
        MemoryStream ms = new MemoryStream();
        ms.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }, 0, 8);
        WriteUInt32BE(ms, 13);
        byte[] ihdr = new byte[17];
        byte[] type = Encoding.ASCII.GetBytes("IHDR");
        Buffer.BlockCopy(type, 0, ihdr, 0, 4);
        ihdr[4] = (byte)((width >> 24) & 0xFF);
        ihdr[5] = (byte)((width >> 16) & 0xFF);
        ihdr[6] = (byte)((width >> 8) & 0xFF);
        ihdr[7] = (byte)(width & 0xFF);
        ihdr[8] = (byte)((height >> 24) & 0xFF);
        ihdr[9] = (byte)((height >> 16) & 0xFF);
        ihdr[10] = (byte)((height >> 8) & 0xFF);
        ihdr[11] = (byte)(height & 0xFF);
        ihdr[12] = 8;
        ihdr[13] = 6;
        ihdr[14] = 0;
        ihdr[15] = 0;
        ihdr[16] = 0;
        ms.Write(ihdr, 0, 17);
        WriteUInt32BE(ms, 4);
        byte[] idatData = new byte[] { 1, 2, 3, 4 };
        WriteUInt32BE(ms, (uint)idatData.Length);
        ms.Write(Encoding.ASCII.GetBytes("IDAT"), 0, 4);
        ms.Write(idatData, 0, idatData.Length);
        WriteUInt32BE(ms, 4);
        WriteUInt32BE(ms, 0);
        ms.Write(Encoding.ASCII.GetBytes("IEND"), 0, 4);
        WriteUInt32BE(ms, 0);
        return ms.ToArray();
    }

    static void WriteUInt32BE(MemoryStream ms, uint v) {
        ms.WriteByte((byte)((v >> 24) & 0xFF));
        ms.WriteByte((byte)((v >> 16) & 0xFF));
        ms.WriteByte((byte)((v >> 8) & 0xFF));
        ms.WriteByte((byte)(v & 0xFF));
    }
}
