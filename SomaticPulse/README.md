# SomaticPulse

A psychoacoustic resonance plug-in: a binaural sub-oscillator, a somatic pulse
LFO, a Solfeggio resonator with micro-detune, and a phase-safe output stage —
designed to sit under musical stems without muddying the low end or collapsing
on a mono system.

- **Formats:** VST3, Standalone, and AU on macOS
- **Framework:** JUCE 8.0.15, C++20, CMake
- **Real-time safety:** no allocation, no locks and no blocking calls in
  `processBlock`; every audible parameter runs through a 20 ms
  `juce::SmoothedValue` ramp.

## Build

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

JUCE is fetched automatically (tag `8.0.15`). To use a checkout you already
have, and skip the download:

```bash
cmake -S . -B build -DJUCE_DIR=/path/to/JUCE -DCMAKE_BUILD_TYPE=Release
```

Useful options:

| Option | Default | Meaning |
| --- | --- | --- |
| `SOMATICPULSE_COPY_PLUGIN_AFTER_BUILD` | `ON` | Copy the built plug-in into the system VST3 / AU folder |
| `SOMATICPULSE_JUCE_TAG` | `8.0.15` | JUCE release used by `FetchContent` |
| `SOMATICPULSE_BUILD_TOOLS` | `OFF` | Also build the offline verification harness |

Artefacts land under `build/SomaticPulse_artefacts/Release/`.

### Linux build dependencies

```bash
sudo apt install libasound2-dev libfreetype6-dev libfontconfig1-dev \
                 libx11-dev libxext-dev libxinerama-dev libxrandr-dev \
                 libxcursor-dev libxcomposite-dev libgl1-mesa-dev
```

`JUCE_WEB_BROWSER=0` and `JUCE_USE_CURL=0` are set, so WebKit and GTK are not
needed.

## Prebuilt downloads

Every push builds the plug-in for Windows, macOS and Linux in GitHub Actions
and attaches it to the run. Open the repository's **Actions** tab, click the
most recent *Build plugin* run, and download the artifact for your platform
from the **Artifacts** section at the bottom:

| Artifact | Contains |
| --- | --- |
| `SomaticPulse-Windows-VST3` | `SomaticPulse.vst3` + standalone `.exe` |
| `SomaticPulse-macOS-VST3-AU` | `SomaticPulse.vst3`, `SomaticPulse.component`, standalone `.app` (universal, arm64 + x86_64) |
| `SomaticPulse-Linux-VST3` | `SomaticPulse.vst3` + standalone binary |

The builds are unsigned. On macOS, clear the download quarantine flag before
the plug-in will load:

```bash
xattr -dr com.apple.quarantine ~/Library/Audio/Plug-Ins/VST3/SomaticPulse.vst3
```

## Loading it in FL Studio

A plug-in binary is platform-specific: build on the machine you will run it on.
A `.vst3` built on Linux will not load in FL Studio on Windows or macOS.

1. Build on your own machine with the commands above. With
   `SOMATICPULSE_COPY_PLUGIN_AFTER_BUILD=ON` the bundle is installed for you;
   otherwise copy `SomaticPulse.vst3` into
   `C:\Program Files\Common Files\VST3` (Windows) or
   `/Library/Audio/Plug-Ins/VST3` (macOS).
2. In FL Studio: **Options → Manage plugins → Find more plugins**. Add the
   folder if it is not already in the search list, then **Start scan**.
3. The plug-in appears under *Somatic Audio → SomaticPulse*, category
   *Fx / Modulation / Spatial*.
4. Drop it on a **mixer insert**, not the master, so it can duck against that
   track's own material. A send track works too — set *Dry/Wet* to 0 there so
   only the generated sub is added.

### A first pass that actually works

1. Start from **444Hz Somatic Sub Bed** and solo the track.
2. Set *Carrier* to a sub-octave of the key you are in (111 Hz suits A-based
   material; 132 Hz suits C).
3. Raise *Sub Level* until you feel it on a sub or headphones, then back off
   3 dB.
4. Turn *Duck Sub To Track* on and set *Amount* so the sub steps out of the way
   of the kick. Watch the **CORRELATION** readout: above +0.5 the low end is
   mono-safe.
5. Switch *Tempo Sync* on and pick a division so the pulse locks to the track.
6. Check the result in mono. If the beat vanishes, that is the mono-maker doing
   its job — raise *Carrier* above the *Mono Below* corner, or turn
   *Headphones* on if the mix is headphone-only.

**Headphones vs speakers.** A binaural beat is a left/right difference, so
summing the band it lives in cancels it. *Headphone Mode* bypasses the
mono-maker and keeps the beat; leaving it off keeps the mix mono-compatible and
costs the beat below the crossover. The two cannot both be true below the
corner, and the plug-in does not pretend otherwise.

## Verifying the engine

```bash
cmake -S . -B build -DSOMATICPULSE_BUILD_TOOLS=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --target SomaticPulseVerify
./build/SomaticPulseVerify_artefacts/Release/SomaticPulseVerify
```

The harness drives the real processor through its public parameter interface
and measures the output: the binaural split frequencies, mono-maker
cancellation, the soft ceiling, ducking depth, tempo-synced pulse rate, every
factory preset, and the state round-trip.

## Layout

```
CMakeLists.txt
Source/
  ParameterIDs.h              every APVTS id in one place
  PluginProcessor.{h,cpp}     parameter layout, processBlock, state
  PluginEditor.{h,cpp}        controls, cards, layout
  FactoryPresets.{h,cpp}      the six presets, in real units
  DSP/
    BinauralOscillator.{h,cpp}  double-precision split carriers
    SomaticPulseLFO.{h,cpp}     unipolar pulse, four shapes, tempo sync
    SolfeggioResonator.{h,cpp}  parallel TPT bandpasses + micro-detune
    PhaseSafeCrossover.{h,cpp}  ducking, LR4 mono-maker, DC block, ceiling
    ScopeBuffer.h               lock-free audio-to-UI hand-off
  UI/
    CustomLookAndFeel.{h,cpp}   palette, typography, controls
    WaveformVisualizer.{h,cpp}  vectorscope and pulse trace
Tools/
  OfflineRender.cpp           verification harness (not built by default)
```
