#include "PluginProcessor.h"
#include "PluginEditor.h"
#include "FactoryPresets.h"
#include "ParameterIDs.h"

namespace SomaticPulse
{
namespace
{
    namespace P = ParamID;

    constexpr int stateVersion = 1;

    /** Below this the sub level control reads as -inf and the gain is zero. */
    constexpr float minimumSubLevelDb = -60.0f;

    // The default float-to-text conversion prints two decimals for
    // everything, which turns a frequency into "111.00" and a percentage into
    // "50.00". Each of these says how many digits the quantity is actually
    // meaningful to, and the host's automation display gets the same benefit.
    juce::AudioParameterFloatAttributes hzAttributes()
    {
        return juce::AudioParameterFloatAttributes()
            .withLabel ("Hz")
            .withStringFromValueFunction ([] (float v, int)
                                          { return juce::String (v, v < 100.0f ? 2 : 1); });
    }

    /** Hertz above 1 Hz, cycles per minute below it - where breath rates live. */
    juce::AudioParameterFloatAttributes rateAttributes()
    {
        return juce::AudioParameterFloatAttributes()
            .withLabel ("Hz")
            .withStringFromValueFunction ([] (float v, int)
                                          {
                                              if (v < 1.0f)
                                                  return juce::String (v * 60.0f, 1) + "/min";

                                              return juce::String (v, 2) + " Hz";
                                          });
    }

    juce::AudioParameterFloatAttributes percentAttributes()
    {
        return juce::AudioParameterFloatAttributes()
            .withLabel ("%")
            .withStringFromValueFunction ([] (float v, int)
                                          { return juce::String (juce::roundToInt (v)); });
    }

    juce::AudioParameterFloatAttributes dbAttributes()
    {
        return juce::AudioParameterFloatAttributes()
            .withLabel ("dB")
            .withStringFromValueFunction ([] (float v, int)
                                          {
                                              if (v <= minimumSubLevelDb)
                                                  return juce::String ("-inf");

                                              return juce::String (v, 1);
                                          });
    }

    juce::AudioParameterFloatAttributes msAttributes()
    {
        return juce::AudioParameterFloatAttributes()
            .withLabel ("ms")
            .withStringFromValueFunction ([] (float v, int)
                                          { return juce::String (juce::roundToInt (v)); });
    }

    /** Range skewed so the useful low end gets most of the knob travel. */
    juce::NormalisableRange<float> skewed (float lo, float hi, float centre)
    {
        juce::NormalisableRange<float> range { lo, hi };
        range.setSkewForCentre (centre);
        return range;
    }
}

// ---------------------------------------------------------------------------
// Parameter layout
// ---------------------------------------------------------------------------
juce::AudioProcessorValueTreeState::ParameterLayout
SomaticPulseProcessor::createParameterLayout()
{
    using namespace juce;
    AudioProcessorValueTreeState::ParameterLayout layout;

    const auto v = 1;   // version hint: bump only if a range changes meaning

    // --- Binaural sub-oscillator -------------------------------------------
    layout.add (std::make_unique<AudioParameterBool> (ParameterID { P::oscEnable, v },
                                                      "Sub Osc", true));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::carrierHz, v },
                                                       "Carrier", skewed (30.0f, 528.0f, 150.0f),
                                                       111.0f, hzAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::beatHz, v },
                                                       "Beat Offset", skewed (0.0f, 40.0f, 8.0f),
                                                       6.0f, hzAttributes()));
    layout.add (std::make_unique<AudioParameterChoice> (ParameterID { P::oscWave, v },
                                                        "Sub Wave",
                                                        StringArray { "Sine", "Triangle" }, 0));
    layout.add (std::make_unique<AudioParameterChoice> (ParameterID { P::beatMode, v },
                                                        "Beat Mode",
                                                        StringArray { "Binaural", "Monaural",
                                                                      "Isochronic" }, 0));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::oscDrive, v },
                                                       "Warmth", NormalisableRange<float> { 0.0f, 100.0f },
                                                       0.0f, percentAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::subLevelDb, v },
                                                       "Sub Level",
                                                       NormalisableRange<float> { minimumSubLevelDb, 6.0f },
                                                       -12.0f, dbAttributes()));

    // --- Somatic pulse LFO --------------------------------------------------
    layout.add (std::make_unique<AudioParameterBool> (ParameterID { P::lfoEnable, v },
                                                      "Pulse", true));
    layout.add (std::make_unique<AudioParameterBool> (ParameterID { P::lfoSync, v },
                                                      "Tempo Sync", false));
    // Floor at 0.05 Hz, not 0.5. Resonance-frequency breathing sits at about
    // 0.1 Hz - six breaths a minute - with individual rates between 4.5 and
    // 7.0 breaths a minute. A 0.5 Hz floor is thirty breaths a minute, so the
    // old range could not express a breath pace at all.
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::lfoRateHz, v },
                                                       "Pulse Rate", skewed (0.05f, 30.0f, 2.0f),
                                                       6.0f, rateAttributes()));
    layout.add (std::make_unique<AudioParameterChoice> (ParameterID { P::lfoDivision, v },
                                                        "Division",
                                                        StringArray { "1/1", "1/2", "1/4", "1/8",
                                                                      "1/8T", "1/16", "1/32" }, 2));
    layout.add (std::make_unique<AudioParameterChoice> (ParameterID { P::lfoShape, v },
                                                        "Pulse Shape",
                                                        StringArray { "Sine", "Smooth Pulse",
                                                                      "Triangle", "Double-Thump" }, 0));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::lfoDepthSub, v },
                                                       "Depth: Sub", NormalisableRange<float> { 0.0f, 100.0f },
                                                       50.0f, percentAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::lfoDepthAudio, v },
                                                       "Depth: Audio", NormalisableRange<float> { 0.0f, 100.0f },
                                                       0.0f, percentAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::lfoDepthFilter, v },
                                                       "Depth: Filter", NormalisableRange<float> { 0.0f, 100.0f },
                                                       0.0f, percentAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::lfoStereoPhase, v },
                                                       "Stereo Phase",
                                                       NormalisableRange<float> { 0.0f, 180.0f }, 0.0f,
                                                       AudioParameterFloatAttributes()
                                                           .withLabel ("deg")
                                                           .withStringFromValueFunction ([] (float v, int)
                                                                                         { return String (roundToInt (v)); })));

    // --- Solfeggio resonator ------------------------------------------------
    layout.add (std::make_unique<AudioParameterBool> (ParameterID { P::resoEnable, v },
                                                      "Resonator", true));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::resoBaseHz, v },
                                                       "Base Freq", skewed (100.0f, 1000.0f, 440.0f),
                                                       444.0f, hzAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::resoQ, v },
                                                       "Q", NormalisableRange<float> { 4.0f, 24.0f }, 8.0f,
                                                       AudioParameterFloatAttributes()
                                                           .withStringFromValueFunction ([] (float value, int)
                                                                                         { return String (value, 1); })));
    layout.add (std::make_unique<AudioParameterInt> (ParameterID { P::resoHarmonics, v },
                                                     "Harmonics", 1, SolfeggioResonator::maxHarmonics, 3));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::resoAmount, v },
                                                       "Resonance Amount",
                                                       NormalisableRange<float> { 0.0f, 100.0f },
                                                       0.0f, percentAttributes()));
    layout.add (std::make_unique<AudioParameterBool> (ParameterID { P::detuneEnable, v },
                                                      "Tuning Shift", false));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::detuneCents, v },
                                                       "Detune",
                                                       NormalisableRange<float> { -31.77f, 15.67f }, 0.0f,
                                                       AudioParameterFloatAttributes()
                                                           .withLabel ("cents")
                                                           .withStringFromValueFunction ([] (float v, int)
                                                                                         { return String (v, 2); })));

    // --- Session timing -----------------------------------------------------
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::sessionMinutes, v },
                                                       "Session Length",
                                                       NormalisableRange<float> { 0.0f, 60.0f }, 0.0f,
                                                       AudioParameterFloatAttributes()
                                                           .withLabel ("min")
                                                           .withStringFromValueFunction ([] (float value, int)
                                                                                         {
                                                                                             if (value < 0.05f)
                                                                                                 return String ("Off");

                                                                                             return String (value, 1);
                                                                                         })));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::sessionFadePct, v },
                                                       "Fade", NormalisableRange<float> { 0.0f, 50.0f },
                                                       10.0f, percentAttributes()));
    layout.add (std::make_unique<AudioParameterBool> (ParameterID { P::rampEnable, v },
                                                      "Ramp", false));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::rampBeatHz, v },
                                                       "Beat Target", skewed (0.0f, 40.0f, 8.0f),
                                                       4.0f, hzAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::rampRateHz, v },
                                                       "Pulse Target", skewed (0.05f, 30.0f, 2.0f),
                                                       1.0f, rateAttributes()));

    // --- Tactile transducer send -------------------------------------------
    layout.add (std::make_unique<AudioParameterBool> (ParameterID { P::tactileEnable, v },
                                                      "Tactile Send", false));
    layout.add (std::make_unique<AudioParameterChoice> (ParameterID { P::tactileRouting, v },
                                                        "Routing",
                                                        StringArray { "Audio + Tactile",
                                                                      "Tactile Only" }, 0));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::tactileLevelDb, v },
                                                       "Tactile Level",
                                                       NormalisableRange<float> { minimumSubLevelDb, 12.0f },
                                                       -6.0f, dbAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::tactileHpHz, v },
                                                       "Tactile HP", NormalisableRange<float> { 5.0f, 80.0f },
                                                       20.0f, hzAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::tactileLpHz, v },
                                                       "Tactile LP", NormalisableRange<float> { 40.0f, 200.0f },
                                                       120.0f, hzAttributes()));

    // --- Mix and dynamics ---------------------------------------------------
    layout.add (std::make_unique<AudioParameterBool> (ParameterID { P::duckEnable, v },
                                                      "Ducking", false));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::duckAmount, v },
                                                       "Duck Amount", NormalisableRange<float> { 0.0f, 100.0f },
                                                       50.0f, percentAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::duckAttackMs, v },
                                                       "Duck Attack", skewed (1.0f, 100.0f, 15.0f),
                                                       10.0f, msAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::duckReleaseMs, v },
                                                       "Duck Release", skewed (20.0f, 1000.0f, 200.0f),
                                                       150.0f, msAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::crossoverHz, v },
                                                       "Mono Below",
                                                       NormalisableRange<float> { 60.0f, 200.0f },
                                                       120.0f, hzAttributes()));
    layout.add (std::make_unique<AudioParameterBool> (ParameterID { P::headphoneMode, v },
                                                      "Headphone Mode", false));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::dryWet, v },
                                                       "Dry/Wet", NormalisableRange<float> { 0.0f, 100.0f },
                                                       100.0f, percentAttributes()));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::outputGainDb, v },
                                                       "Output", NormalisableRange<float> { -24.0f, 12.0f },
                                                       0.0f, dbAttributes()));
    layout.add (std::make_unique<AudioParameterBool> (ParameterID { P::limiterEnable, v },
                                                      "Limiter", true));
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::ceilingDb, v },
                                                       "Ceiling", NormalisableRange<float> { -12.0f, 0.0f },
                                                       -0.3f, dbAttributes()));

    return layout;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
SomaticPulseProcessor::SomaticPulseProcessor()
    // The tactile bus is off by default: a host that cannot route a second
    // output should see an ordinary stereo effect, not a plug-in that refuses
    // to load. Enabling it is a deliberate act in the host's routing page.
    : AudioProcessor (BusesProperties()
                          .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Tactile", juce::AudioChannelSet::stereo(), false)),
      apvts (*this, nullptr, "SOMATICPULSE", createParameterLayout())
{
    cacheParameterPointers();
}

std::atomic<float>* SomaticPulseProcessor::raw (const char* id) const
{
    auto* p = apvts.getRawParameterValue (id);
    jassert (p != nullptr);     // ID typo: fix the table, do not ship a null
    return p;
}

void SomaticPulseProcessor::cacheParameterPointers()
{
    pOscEnable      = raw (P::oscEnable);
    pCarrierHz      = raw (P::carrierHz);
    pBeatHz         = raw (P::beatHz);
    pOscWave        = raw (P::oscWave);
    pBeatMode       = raw (P::beatMode);
    pOscDrive       = raw (P::oscDrive);
    pSubLevelDb     = raw (P::subLevelDb);

    pLfoEnable      = raw (P::lfoEnable);
    pLfoSync        = raw (P::lfoSync);
    pLfoRateHz      = raw (P::lfoRateHz);
    pLfoDivision    = raw (P::lfoDivision);
    pLfoShape       = raw (P::lfoShape);
    pLfoDepthSub    = raw (P::lfoDepthSub);
    pLfoDepthAudio  = raw (P::lfoDepthAudio);
    pLfoDepthFilter = raw (P::lfoDepthFilter);
    pLfoStereoPhase = raw (P::lfoStereoPhase);

    pResoEnable     = raw (P::resoEnable);
    pResoBaseHz     = raw (P::resoBaseHz);
    pResoQ          = raw (P::resoQ);
    pResoHarmonics  = raw (P::resoHarmonics);
    pResoAmount     = raw (P::resoAmount);
    pDetuneEnable   = raw (P::detuneEnable);
    pDetuneCents    = raw (P::detuneCents);

    pSessionMinutes = raw (P::sessionMinutes);
    pSessionFadePct = raw (P::sessionFadePct);
    pRampEnable     = raw (P::rampEnable);
    pRampBeatHz     = raw (P::rampBeatHz);
    pRampRateHz     = raw (P::rampRateHz);

    pTactileEnable  = raw (P::tactileEnable);
    pTactileRouting = raw (P::tactileRouting);
    pTactileLevelDb = raw (P::tactileLevelDb);
    pTactileHpHz    = raw (P::tactileHpHz);
    pTactileLpHz    = raw (P::tactileLpHz);

    pDuckEnable     = raw (P::duckEnable);
    pDuckAmount     = raw (P::duckAmount);
    pDuckAttackMs   = raw (P::duckAttackMs);
    pDuckReleaseMs  = raw (P::duckReleaseMs);
    pCrossoverHz    = raw (P::crossoverHz);
    pHeadphoneMode  = raw (P::headphoneMode);
    pDryWet         = raw (P::dryWet);
    pOutputGainDb   = raw (P::outputGainDb);
    pLimiterEnable  = raw (P::limiterEnable);
    pCeilingDb      = raw (P::ceilingDb);
}

void SomaticPulseProcessor::prepareToPlay (double sampleRate, int maximumExpectedSamplesPerBlock)
{
    // Always prepare the internal chain as stereo. A binaural beat is a
    // two-channel object by definition, so the DSP works in stereo and the
    // mono case is folded down at the very end.
    juce::dsp::ProcessSpec spec {};
    spec.sampleRate = sampleRate;
    spec.maximumBlockSize = static_cast<juce::uint32> (juce::jmax (1, maximumExpectedSamplesPerBlock));
    spec.numChannels = 2;

    oscillator.prepare (spec);
    lfo.prepare (spec);
    resonator.prepare (spec);
    outputStage.prepare (spec);
    tactile.prepare (spec);
    meter.prepare (spec);
    session.prepare (sampleRate);

    scope.clear();

    oscillator.snapToTargets();
    resonator.snapToTargets();
    outputStage.snapToTargets();
    tactile.snapToTargets();

    wasPlaying = false;
    lastTimeInSamples = 0;
}

void SomaticPulseProcessor::releaseResources()
{
    oscillator.reset();
    lfo.reset();
    resonator.reset();
    outputStage.reset();
    tactile.reset();
    meter.reset();
    session.reset();
    scope.clear();
}

bool SomaticPulseProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto mono = juce::AudioChannelSet::mono();
    const auto stereo = juce::AudioChannelSet::stereo();

    const auto& out = layouts.getMainOutputChannelSet();
    const auto& in  = layouts.getMainInputChannelSet();

    if (out != mono && out != stereo)
        return false;

    // Input may be absent (the plugin still generates a sub), but if present
    // it has to match the output width.
    if (! (in.isDisabled() || in == out))
        return false;

    if (layouts.outputBuses.size() > 1)
    {
        const auto& tactileSet = layouts.getChannelSet (false, 1);

        if (! (tactileSet.isDisabled() || tactileSet == mono || tactileSet == stereo))
            return false;
    }

    return true;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------
void SomaticPulseProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    auto mainOut = getBusBuffer (buffer, false, 0);
    auto mainIn  = getBusBuffer (buffer, true, 0);

    const auto numSamples = mainOut.getNumSamples();
    const auto outChannels = mainOut.getNumChannels();

    // --- Second output bus -------------------------------------------------
    float* tactileLeft = nullptr;
    float* tactileRight = nullptr;
    bool tactileBusPresent = false;

    if (getBusCount (false) > 1)
    {
        if (auto* bus = getBus (false, 1); bus != nullptr && bus->isEnabled())
        {
            auto tactileOut = getBusBuffer (buffer, false, 1);

            if (tactileOut.getNumChannels() > 0 && tactileOut.getNumSamples() > 0)
            {
                // Cleared unconditionally: whatever the host left here is not
                // ours, and a disabled send must be silent rather than stale.
                tactileOut.clear();

                tactileBusPresent = true;
                tactileLeft = tactileOut.getWritePointer (0);
                tactileRight = tactileOut.getNumChannels() > 1 ? tactileOut.getWritePointer (1)
                                                               : nullptr;
            }
        }
    }

    tactileBusConnected.store (tactileBusPresent, std::memory_order_relaxed);

    if (numSamples <= 0 || outChannels <= 0)
        return;

    // No input bus at all: the plug-in still generates, but there is no dry
    // signal and whatever the host left in the buffer is not one.
    if (mainIn.getNumChannels() <= 0)
        mainOut.clear();

    const auto isStereo = outChannels > 1;

    // --- Block-rate parameter read ----------------------------------------
    const auto oscOn      = pOscEnable->load() > 0.5f;
    const auto lfoOn      = pLfoEnable->load() > 0.5f;
    const auto resoOn     = pResoEnable->load() > 0.5f;
    const auto headphones = pHeadphoneMode->load() > 0.5f;

    // --- Session clock ------------------------------------------------------
    session.setLengthSeconds (static_cast<double> (pSessionMinutes->load()) * 60.0);
    session.setFadeFraction (pSessionFadePct->load() * 0.01f);

    if (sessionRestartRequested.exchange (false, std::memory_order_relaxed))
        session.reset();

    if (auto* playHead = getPlayHead())
    {
        if (const auto position = playHead->getPosition())
        {
            if (const auto bpm = position->getBpm())
                lfo.setHostTempo (*bpm);

            const auto playing = position->getIsPlaying();
            const auto timeInSamples = position->getTimeInSamples().orFallback (0);

            // Starting the transport, or locating backwards, is what a user
            // means by "run the session again".
            if ((playing && ! wasPlaying) || timeInSamples < lastTimeInSamples)
                session.reset();

            wasPlaying = playing;
            lastTimeInSamples = timeInSamples;
        }
    }

    const auto sessionIntensity = session.getIntensity();
    const auto sessionProgress = session.getProgress();

    // --- Session ramp -------------------------------------------------------
    auto beatHz = pBeatHz->load();
    auto pulseRateHz = pLfoRateHz->load();

    if (pRampEnable->load() > 0.5f && session.isEnabled())
    {
        beatHz      += (pRampBeatHz->load() - beatHz) * sessionProgress;
        pulseRateHz += (pRampRateHz->load() - pulseRateHz) * sessionProgress;
    }

    const auto subLevelDb = pSubLevelDb->load();
    const auto subGain    = subLevelDb <= minimumSubLevelDb
                              ? 0.0f
                              : juce::Decibels::decibelsToGain (subLevelDb);

    oscillator.setCarrierFrequency (pCarrierHz->load());
    oscillator.setBeatFrequency (beatHz);
    oscillator.setDrive (pOscDrive->load() * 0.01f);
    oscillator.setLevel (oscOn ? subGain * sessionIntensity : 0.0f);
    oscillator.setWaveform (pOscWave->load() < 0.5f ? BinauralOscillator::Waveform::Sine
                                                    : BinauralOscillator::Waveform::Triangle);
    oscillator.setMode (static_cast<BinauralOscillator::Mode> (
        juce::jlimit (0, 2, static_cast<int> (pBeatMode->load()))));

    lfo.setFreeRunningRate (pulseRateHz);
    lfo.setTempoSynced (pLfoSync->load() > 0.5f);
    lfo.setDivision (static_cast<SomaticPulseLFO::Division> (static_cast<int> (pLfoDivision->load())));
    lfo.setShape (static_cast<SomaticPulseLFO::Shape> (static_cast<int> (pLfoShape->load())));
    lfo.setStereoPhaseDegrees (pLfoStereoPhase->load());

    resonator.setBaseFrequency (pResoBaseHz->load());
    resonator.setQ (pResoQ->load());
    resonator.setNumHarmonics (static_cast<int> (pResoHarmonics->load()));
    resonator.setAmount (resoOn ? pResoAmount->load() * 0.01f : 0.0f);
    resonator.setDetuneEnabled (resoOn && pDetuneEnable->load() > 0.5f);
    resonator.setDetuneCents (pDetuneCents->load());

    outputStage.setDuckEnabled (pDuckEnable->load() > 0.5f);
    outputStage.setDuckAmount (pDuckAmount->load() * 0.01f);
    outputStage.setDuckTimes (pDuckAttackMs->load(), pDuckReleaseMs->load());
    outputStage.setCrossoverFrequency (pCrossoverHz->load());
    outputStage.setMonoMakerEnabled (! headphones);
    outputStage.setOutputGain (juce::Decibels::decibelsToGain (pOutputGainDb->load()));
    outputStage.setLimiterEnabled (pLimiterEnable->load() > 0.5f);
    outputStage.setCeiling (juce::Decibels::decibelsToGain (pCeilingDb->load()));

    // --- Tactile send -------------------------------------------------------
    const auto tactileOn = pTactileEnable->load() > 0.5f && tactileBusPresent;
    const auto tactileLevelDb = pTactileLevelDb->load();

    tactile.setLevel (tactileOn && tactileLevelDb > minimumSubLevelDb
                          ? juce::Decibels::decibelsToGain (tactileLevelDb)
                          : 0.0f);
    tactile.setHighpassFrequency (pTactileHpHz->load());
    tactile.setLowpassFrequency (pTactileLpHz->load());

    // "Tactile Only" is ignored unless a transducer bus actually exists,
    // otherwise selecting it in a host with no second output would simply
    // mute the plug-in with no way to tell why.
    const auto muteMainBus = tactileOn && pTactileRouting->load() > 0.5f;

    const auto depthSub    = pLfoDepthSub->load() * 0.01f;
    const auto depthAudio  = pLfoDepthAudio->load() * 0.01f;
    const auto depthFilter = pLfoDepthFilter->load() * 0.01f;
    const auto wet         = pDryWet->load() * 0.01f * sessionIntensity;

    auto* left  = mainOut.getWritePointer (0);
    auto* right = isStereo ? mainOut.getWritePointer (1) : nullptr;

    float blockPeak = 0.0f;

    // --- Per-sample --------------------------------------------------------
    for (int i = 0; i < numSamples; ++i)
    {
        const auto dryL = left[i];
        const auto dryR = isStereo ? right[i] : dryL;

        // The LFO is unipolar: 1 means "untouched", 0 means "fully ducked".
        float lfoL = 1.0f, lfoR = 1.0f;

        if (lfoOn)
            lfo.processSample (lfoL, lfoR);

        const auto subModL = 1.0f - depthSub * (1.0f - lfoL);
        const auto subModR = 1.0f - depthSub * (1.0f - lfoR);
        const auto audModL = 1.0f - depthAudio * (1.0f - lfoL);
        const auto audModR = 1.0f - depthAudio * (1.0f - lfoR);

        // Follow the *dry* signal, not the output. Following the output
        // would let the sub duck itself and the loop would pump.
        const auto duck = outputStage.updateDuckGain (dryL, dryR);

        // Floor the filter modulation at a quarter of the base frequency:
        // sweeping a Q = 24 band all the way to DC just makes it disappear.
        const auto lfoMean = 0.5f * (lfoL + lfoR);
        resonator.setCutoffModulation (1.0f - depthFilter * (1.0f - lfoMean) * 0.75f);

        auto procL = dryL * audModL;
        auto procR = dryR * audModR;

        resonator.processFrame (procL, procR);

        // Dry/wet applies to the *processing* of incoming audio only. The
        // generated sub has its own level control, including an -inf
        // position, so folding it in here would give two controls that both
        // mute it and neither of which fully explains the result.
        const auto mixL = dryL + wet * (procL - dryL);
        const auto mixR = dryR + wet * (procR - dryR);

        float subL = 0.0f, subR = 0.0f;
        oscillator.processSample (subModL * duck, subModR * duck, subL, subR);

        auto outL = mixL + subL;
        auto outR = mixR + subR;

        outputStage.processFrame (outL, outR);

        // The scope shows what the engine produced, so it keeps working in
        // Tactile Only mode where the main bus is silent by design.
        scope.push (outL, outR);

        if (tactileOn)
        {
            float tactL = 0.0f, tactR = 0.0f;
            tactile.processFrame (outL, outR, tactL, tactR);

            tactileLeft[i] = tactL;

            if (tactileRight != nullptr)
                tactileRight[i] = tactR;
        }

        if (muteMainBus)
        {
            outL = 0.0f;
            outR = 0.0f;
        }

        // The loudness meter measures the main bus after the mute, because
        // it answers "how loud is what leaves this plug-in".
        meter.processFrame (outL, outR);

        blockPeak = juce::jmax (blockPeak, std::abs (outL), std::abs (outR));

        if (isStereo)
        {
            left[i]  = outL;
            right[i] = outR;
        }
        else
        {
            left[i] = 0.5f * (outL + outR);
        }
    }

    session.advance (numSamples);
    meter.captureMax();

    lfoValueForUI.store (lfo.getLastValue(), std::memory_order_relaxed);
    outputPeakForUI.store (blockPeak, std::memory_order_relaxed);
    loudnessForUI.store (meter.getMomentaryLufs(), std::memory_order_relaxed);
    loudnessMaxForUI.store (meter.getMaxMomentaryLufs(), std::memory_order_relaxed);
    sessionElapsedForUI.store (static_cast<float> (session.getElapsedSeconds()), std::memory_order_relaxed);
    sessionLengthForUI.store (static_cast<float> (session.getLengthSeconds()), std::memory_order_relaxed);
    sessionIntensityForUI.store (sessionIntensity, std::memory_order_relaxed);
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------
int SomaticPulseProcessor::getNumPrograms()
{
    return FactoryPresets::getNumPresets();
}

void SomaticPulseProcessor::setCurrentProgram (int index)
{
    if (! juce::isPositiveAndBelow (index, getNumPrograms()))
        return;

    currentProgram = index;
    FactoryPresets::applyPreset (index, apvts);
}

const juce::String SomaticPulseProcessor::getProgramName (int index)
{
    return FactoryPresets::getPresetName (index);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
void SomaticPulseProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    auto state = apvts.copyState();

    if (auto xml = state.createXml())
    {
        xml->setAttribute ("stateVersion", stateVersion);
        xml->setAttribute ("currentProgram", currentProgram);
        copyXmlToBinary (*xml, destData);
    }
}

void SomaticPulseProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    auto xml = getXmlFromBinary (data, sizeInBytes);

    if (xml == nullptr)
        return;

    // Reject anything that is not ours rather than letting ValueTree build a
    // tree with the wrong type and silently reset every parameter.
    if (! xml->hasTagName (apvts.state.getType()))
        return;

    const auto version = xml->getIntAttribute ("stateVersion", 1);

    if (version > stateVersion)
    {
        // Saved by a newer build. Loading it would apply whichever
        // parameters happen to still match and leave the rest at defaults,
        // which is worse than leaving the plugin as it is.
        jassertfalse;
        return;
    }

    currentProgram = xml->getIntAttribute ("currentProgram", 0);
    apvts.replaceState (juce::ValueTree::fromXml (*xml));
}

juce::AudioProcessorEditor* SomaticPulseProcessor::createEditor()
{
    return new SomaticPulseEditor (*this);
}
} // namespace SomaticPulse

// ---------------------------------------------------------------------------
// Entry point for every plugin format wrapper.
// ---------------------------------------------------------------------------
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new SomaticPulse::SomaticPulseProcessor();
}
