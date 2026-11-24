#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <functional>
#include <memory>

#include "PluginProcessor.h"
#include "UI/CustomLookAndFeel.h"
#include "UI/WaveformVisualizer.h"

namespace SomaticPulse
{
/** Rotary knob with a caption underneath and the parameter's own value text. */
class KnobControl final : public juce::Component
{
public:
    KnobControl (juce::AudioProcessorValueTreeState& state,
                 const juce::String& parameterID,
                 const juce::String& caption,
                 const juce::String& suffix = {});

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    static constexpr int captionHeight = 12;

    juce::String captionText;
    juce::Slider slider;
    juce::AudioProcessorValueTreeState::SliderAttachment attachment;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (KnobControl)
};

/** Horizontal slider with its caption on the left and its value on the right. */
class SliderControl final : public juce::Component
{
public:
    SliderControl (juce::AudioProcessorValueTreeState& state,
                   const juce::String& parameterID,
                   const juce::String& caption,
                   const juce::String& suffix = {});

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    static constexpr int captionWidth = 54;

    juce::String captionText;
    juce::Slider slider;
    juce::AudioProcessorValueTreeState::SliderAttachment attachment;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SliderControl)
};

/** Combo box fed from an AudioParameterChoice, with a caption above it. */
class ChoiceControl final : public juce::Component
{
public:
    ChoiceControl (juce::AudioProcessorValueTreeState& state,
                   const juce::String& parameterID,
                   const juce::String& caption);

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    static constexpr int captionHeight = 11;

    juce::String captionText;
    juce::ComboBox box;

    // Built after the box is populated: the attachment copies the parameter's
    // current index into the box, which needs the items to exist first.
    std::unique_ptr<juce::AudioProcessorValueTreeState::ComboBoxAttachment> attachment;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ChoiceControl)
};

/** Pill switch bound to an AudioParameterBool. */
class SwitchControl final : public juce::Component
{
public:
    SwitchControl (juce::AudioProcessorValueTreeState& state,
                   const juce::String& parameterID,
                   const juce::String& text);

    void resized() override;

private:
    juce::ToggleButton button;
    juce::AudioProcessorValueTreeState::ButtonAttachment attachment;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SwitchControl)
};

/**
    Where the carrier sits relative to how the body reads vibration.

    The numbers behind the zones: fingertip vibrotactile sensitivity peaks
    near 250 Hz through the Pacinian channel, which spans roughly 65-400 Hz,
    while a bench study of seven consumer vibrators measured them between 43
    and 148 Hz. Below about 60 Hz is felt as pressure and movement rather
    than vibration, and above 400 Hz the sensation thins out into tone.

    None of that is visible on a frequency knob, so the strip draws it.
*/
class CarrierScale final : public juce::Component
{
public:
    CarrierScale (juce::AudioProcessorValueTreeState& state, const juce::String& parameterID);

    void paint (juce::Graphics&) override;

    /** Repaints only when the carrier has actually moved. */
    void refresh();

private:
    static constexpr float minHz = 30.0f;
    static constexpr float maxHz = 528.0f;

    static float positionFor (float hz);

    juce::RangedAudioParameter* parameter = nullptr;
    float lastValue = -1.0f;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (CarrierScale)
};

/** Caption plus a live value, polled by the editor rather than pushed. */
class ValueReadout final : public juce::Component
{
public:
    using Provider = std::function<juce::String()>;

    ValueReadout (juce::String caption, Provider provider, juce::Colour colour);

    void paint (juce::Graphics&) override;
    void refresh();

private:
    juce::String captionText;
    juce::String cachedValue;
    Provider read;
    juce::Colour valueColour;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ValueReadout)
};

/** Frosted panel with a titled header. Purely a background. */
class GlassCard final : public juce::Component
{
public:
    GlassCard (juce::String cardTitle, juce::Colour accent);

    void paint (juce::Graphics&) override;

    /** Where this card's controls belong, in the parent's coordinates. */
    juce::Rectangle<int> getContentBounds() const;

private:
    juce::String title;
    juce::Colour accentColour;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (GlassCard)
};

// ---------------------------------------------------------------------------
class SomaticPulseEditor final : public juce::AudioProcessorEditor,
                                 private juce::Timer
{
public:
    explicit SomaticPulseEditor (SomaticPulseProcessor&);
    ~SomaticPulseEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    void timerCallback() override;
    void layoutContent();
    void buildPresetBox();

    static constexpr int designWidth = 920;
    static constexpr int designHeight = 754;

    SomaticPulseProcessor& processor;
    CustomLookAndFeel customLookAndFeel;

    /**
        Everything lives inside a fixed 920x560 component which is scaled by
        an AffineTransform in resized(). With the aspect ratio locked there is
        one scale factor, so this keeps every margin and type size in
        proportion instead of reflowing the layout at every window size.
    */
    juce::Component content;

    juce::Label titleLabel;
    juce::Label taglineLabel;
    juce::Label presetCaption;
    juce::ComboBox presetBox;

    GlassCard topBar;
    GlassCard coreCard;
    GlassCard pulseCard;
    GlassCard resonanceCard;
    GlassCard mixCard;
    GlassCard sessionCard;
    GlassCard tactileCard;

    WaveformVisualizer visualizer;

    SwitchControl headphoneSwitch;
    SwitchControl limiterSwitch;
    SliderControl outputSlider;
    SliderControl ceilingSlider;

    SwitchControl oscEnableSwitch;
    KnobControl carrierKnob;
    KnobControl beatKnob;
    CarrierScale carrierScale;
    KnobControl subLevelKnob;
    KnobControl driveKnob;
    ChoiceControl waveChoice;
    ChoiceControl beatModeChoice;

    SwitchControl lfoEnableSwitch;
    SwitchControl lfoSyncSwitch;
    ChoiceControl shapeChoice;
    ChoiceControl divisionChoice;
    KnobControl rateKnob;
    KnobControl depthSubKnob;
    KnobControl depthAudioKnob;
    KnobControl depthFilterKnob;
    KnobControl stereoPhaseKnob;

    SwitchControl resoEnableSwitch;
    SwitchControl detuneEnableSwitch;
    KnobControl resoBaseKnob;
    KnobControl resoQKnob;
    KnobControl resoAmountKnob;
    KnobControl harmonicsKnob;
    KnobControl detuneKnob;

    SwitchControl duckEnableSwitch;
    KnobControl duckAmountKnob;
    KnobControl duckAttackKnob;
    KnobControl duckReleaseKnob;
    KnobControl crossoverKnob;
    KnobControl dryWetKnob;

    SwitchControl rampSwitch;
    KnobControl sessionLengthKnob;
    KnobControl sessionFadeKnob;
    KnobControl rampBeatKnob;
    KnobControl rampRateKnob;
    juce::TextButton restartButton { "RESTART" };
    ValueReadout elapsedReadout;
    ValueReadout loudnessReadout;
    ValueReadout loudnessMaxReadout;

    SwitchControl tactileSwitch;
    ChoiceControl tactileRoutingChoice;
    KnobControl tactileLevelKnob;
    KnobControl tactileHpKnob;
    KnobControl tactileLpKnob;
    ValueReadout tactileStatusReadout;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (SomaticPulseEditor)
};
} // namespace SomaticPulse
