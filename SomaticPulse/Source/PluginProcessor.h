#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include "DSP/BinauralOscillator.h"
#include "DSP/PhaseSafeCrossover.h"
#include "DSP/ScopeBuffer.h"
#include "DSP/LoudnessMeter.h"
#include "DSP/SessionClock.h"
#include "DSP/SolfeggioResonator.h"
#include "DSP/SomaticPulseLFO.h"
#include "DSP/TactileSend.h"

namespace SomaticPulse
{
class SomaticPulseProcessor final : public juce::AudioProcessor
{
public:
    SomaticPulseProcessor();
    ~SomaticPulseProcessor() override = default;

    // --- AudioProcessor ----------------------------------------------------
    void prepareToPlay (double sampleRate, int maximumExpectedSamplesPerBlock) override;
    void releaseResources() override;
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override                      { return true; }

    const juce::String getName() const override          { return "SomaticPulse"; }
    bool acceptsMidi() const override                    { return false; }
    bool producesMidi() const override                   { return false; }
    bool isMidiEffect() const override                   { return false; }
    double getTailLengthSeconds() const override         { return 0.0; }

    int getNumPrograms() override;
    int getCurrentProgram() override                     { return currentProgram; }
    void setCurrentProgram (int index) override;
    const juce::String getProgramName (int index) override;
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    // --- Host for the editor ----------------------------------------------
    static juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout();

    juce::AudioProcessorValueTreeState apvts;

    ScopeBuffer& getScopeBuffer() noexcept               { return scope; }

    /** Latest LFO value, for drawing the pulse trace. UI thread. */
    float getLfoValueForUI() const noexcept              { return lfoValueForUI.load (std::memory_order_relaxed); }

    /** Peak output since the last read, for the clip meter. UI thread. */
    float getOutputPeakForUI() const noexcept            { return outputPeakForUI.load (std::memory_order_relaxed); }

    /** Momentary K-weighted loudness of the main bus. UI thread. */
    float getLoudnessForUI() const noexcept              { return loudnessForUI.load (std::memory_order_relaxed); }

    /** Loudest 400 ms window of this session. UI thread. */
    float getLoudnessMaxForUI() const noexcept           { return loudnessMaxForUI.load (std::memory_order_relaxed); }

    /** Seconds elapsed in the current session, 0 when the clock is off. */
    float getSessionElapsedForUI() const noexcept        { return sessionElapsedForUI.load (std::memory_order_relaxed); }

    /** Session length in seconds, 0 when the clock is off. */
    float getSessionLengthForUI() const noexcept         { return sessionLengthForUI.load (std::memory_order_relaxed); }

    /** The session envelope currently applied to generated content. */
    float getSessionIntensityForUI() const noexcept      { return sessionIntensityForUI.load (std::memory_order_relaxed); }

    /** True when the host exposes the second output bus. UI thread. */
    bool isTactileBusConnected() const noexcept          { return tactileBusConnected.load (std::memory_order_relaxed); }

    /** Restarts the session clock from zero. Message thread. */
    void restartSession() noexcept                       { sessionRestartRequested.store (true, std::memory_order_relaxed); }

private:
    /**
        Caches a raw pointer to every parameter's atomic value.

        `getRawParameterValue` walks a map; doing that thirty times per block
        is wasted work on the audio thread, and doing it per sample would be
        indefensible. Resolved once in the constructor instead.
    */
    void cacheParameterPointers();

    std::atomic<float>* raw (const char* id) const;

    BinauralOscillator oscillator;
    SomaticPulseLFO lfo;
    SolfeggioResonator resonator;
    PhaseSafeCrossover outputStage;
    TactileSend tactile;
    SessionClock session;
    LoudnessMeter meter;
    ScopeBuffer scope;

    std::atomic<float> lfoValueForUI { 0.0f };
    std::atomic<float> outputPeakForUI { 0.0f };
    std::atomic<float> loudnessForUI { LoudnessMeter::silenceLufs };
    std::atomic<float> loudnessMaxForUI { LoudnessMeter::silenceLufs };
    std::atomic<float> sessionElapsedForUI { 0.0f };
    std::atomic<float> sessionLengthForUI { 0.0f };
    std::atomic<float> sessionIntensityForUI { 1.0f };
    std::atomic<bool> tactileBusConnected { false };
    std::atomic<bool> sessionRestartRequested { false };

    /** Transport state from the last block, for restarting the session. */
    bool wasPlaying = false;
    juce::int64 lastTimeInSamples = 0;

    int currentProgram = 0;

    // Cached parameter handles, in the order they are declared in the layout.
    std::atomic<float>* pOscEnable      = nullptr;
    std::atomic<float>* pCarrierHz      = nullptr;
    std::atomic<float>* pBeatHz         = nullptr;
    std::atomic<float>* pOscWave        = nullptr;
    std::atomic<float>* pBeatMode       = nullptr;
    std::atomic<float>* pOscDrive       = nullptr;
    std::atomic<float>* pSubLevelDb     = nullptr;

    std::atomic<float>* pLfoEnable      = nullptr;
    std::atomic<float>* pLfoSync        = nullptr;
    std::atomic<float>* pLfoRateHz      = nullptr;
    std::atomic<float>* pLfoDivision    = nullptr;
    std::atomic<float>* pLfoShape       = nullptr;
    std::atomic<float>* pLfoDepthSub    = nullptr;
    std::atomic<float>* pLfoDepthAudio  = nullptr;
    std::atomic<float>* pLfoDepthFilter = nullptr;
    std::atomic<float>* pLfoStereoPhase = nullptr;

    std::atomic<float>* pResoEnable     = nullptr;
    std::atomic<float>* pResoBaseHz     = nullptr;
    std::atomic<float>* pResoQ          = nullptr;
    std::atomic<float>* pResoHarmonics  = nullptr;
    std::atomic<float>* pResoAmount     = nullptr;
    std::atomic<float>* pDetuneEnable   = nullptr;
    std::atomic<float>* pDetuneCents    = nullptr;

    std::atomic<float>* pSessionMinutes = nullptr;
    std::atomic<float>* pSessionFadePct = nullptr;
    std::atomic<float>* pRampEnable     = nullptr;
    std::atomic<float>* pRampBeatHz     = nullptr;
    std::atomic<float>* pRampRateHz     = nullptr;

    std::atomic<float>* pTactileEnable  = nullptr;
    std::atomic<float>* pTactileRouting = nullptr;
    std::atomic<float>* pTactileLevelDb = nullptr;
    std::atomic<float>* pTactileHpHz    = nullptr;
    std::atomic<float>* pTactileLpHz    = nullptr;

    std::atomic<float>* pDuckEnable     = nullptr;
    std::atomic<float>* pDuckAmount     = nullptr;
    std::atomic<float>* pDuckAttackMs   = nullptr;
    std::atomic<float>* pDuckReleaseMs  = nullptr;
    std::atomic<float>* pCrossoverHz    = nullptr;
    std::atomic<float>* pHeadphoneMode  = nullptr;
    std::atomic<float>* pDryWet         = nullptr;
    std::atomic<float>* pOutputGainDb   = nullptr;
    std::atomic<float>* pLimiterEnable  = nullptr;
    std::atomic<float>* pCeilingDb      = nullptr;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SomaticPulseProcessor)
};
} // namespace SomaticPulse
