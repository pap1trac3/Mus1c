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
    layout.add (std::make_unique<AudioParameterFloat> (ParameterID { P::lfoRateHz, v },
                                                       "Pulse Rate", skewed (0.5f, 30.0f, 6.0f),
                                                       6.0f, hzAttributes()));
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
    : AudioProcessor (BusesProperties()
                          .withInput ("Input", juce::AudioChannelSet::stereo(), true)
                          .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
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

    scope.clear();

    oscillator.snapToTargets();
    resonator.snapToTargets();
    outputStage.snapToTargets();
}

void SomaticPulseProcessor::releaseResources()
{
    oscillator.reset();
    lfo.reset();
    resonator.reset();
    outputStage.reset();
    scope.clear();
}

bool SomaticPulseProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& out = layouts.getMainOutputChannelSet();
    const auto& in  = layouts.getMainInputChannelSet();

    if (out != juce::AudioChannelSet::mono() && out != juce::AudioChannelSet::stereo())
        return false;

    // Input may be absent (the plugin still generates a sub), but if present
    // it has to match the output width.
    return in.isDisabled() || in == out;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------
void SomaticPulseProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;

    const auto numSamples = buffer.getNumSamples();
    const auto numInputs  = getTotalNumInputChannels();
    const auto numOutputs = getTotalNumOutputChannels();

    for (int ch = numInputs; ch < numOutputs; ++ch)
        buffer.clear (ch, 0, numSamples);

    if (numSamples <= 0 || numOutputs <= 0)
        return;

    const auto isStereo = numOutputs > 1;

    // --- Block-rate parameter read ----------------------------------------
    const auto oscOn      = pOscEnable->load() > 0.5f;
    const auto lfoOn      = pLfoEnable->load() > 0.5f;
    const auto resoOn     = pResoEnable->load() > 0.5f;
    const auto headphones = pHeadphoneMode->load() > 0.5f;

    const auto subLevelDb = pSubLevelDb->load();
    const auto subGain    = subLevelDb <= minimumSubLevelDb
                              ? 0.0f
                              : juce::Decibels::decibelsToGain (subLevelDb);

    oscillator.setCarrierFrequency (pCarrierHz->load());
    oscillator.setBeatFrequency (pBeatHz->load());
    oscillator.setDrive (pOscDrive->load() * 0.01f);
    oscillator.setLevel (oscOn ? subGain : 0.0f);
    oscillator.setWaveform (pOscWave->load() < 0.5f ? BinauralOscillator::Waveform::Sine
                                                    : BinauralOscillator::Waveform::Triangle);

    lfo.setFreeRunningRate (pLfoRateHz->load());
    lfo.setTempoSynced (pLfoSync->load() > 0.5f);
    lfo.setDivision (static_cast<SomaticPulseLFO::Division> (static_cast<int> (pLfoDivision->load())));
    lfo.setShape (static_cast<SomaticPulseLFO::Shape> (static_cast<int> (pLfoShape->load())));
    lfo.setStereoPhaseDegrees (pLfoStereoPhase->load());

    if (auto* playHead = getPlayHead())
        if (const auto position = playHead->getPosition())
            if (const auto bpm = position->getBpm())
                lfo.setHostTempo (*bpm);

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

    const auto depthSub    = pLfoDepthSub->load() * 0.01f;
    const auto depthAudio  = pLfoDepthAudio->load() * 0.01f;
    const auto depthFilter = pLfoDepthFilter->load() * 0.01f;
    const auto wet         = pDryWet->load() * 0.01f;

    auto* left  = buffer.getWritePointer (0);
    auto* right = isStereo ? buffer.getWritePointer (1) : nullptr;

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

        scope.push (outL, outR);

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

    lfoValueForUI.store (lfo.getLastValue(), std::memory_order_relaxed);
    outputPeakForUI.store (blockPeak, std::memory_order_relaxed);
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
