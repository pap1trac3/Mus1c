#include "PluginEditor.h"
#include "ParameterIDs.h"

#include <vector>

namespace SomaticPulse
{
namespace
{
    namespace P = ParamID;

    /**
        Lays a row of controls across the given area, left to right, in equal
        columns. A null entry leaves its column empty, which is how a row of
        two knobs keeps the same column width as the row of three above it.
    */
    void layoutRow (juce::Rectangle<int>& area, int height, int gap,
                    const std::vector<juce::Component*>& items)
    {
        if (items.empty())
            return;

        auto row = area.removeFromTop (height);

        const auto count = static_cast<int> (items.size());
        const auto cellWidth = (row.getWidth() - gap * (count - 1)) / count;

        for (int i = 0; i < count; ++i)
        {
            const auto isLast = (i == count - 1);
            auto cell = isLast ? row : row.removeFromLeft (cellWidth);

            if (! isLast)
                row.removeFromLeft (gap);

            if (auto* component = items[static_cast<size_t> (i)])
                component->setBounds (cell);
        }
    }

    /** Centres a block of known height inside a card's content area. */
    void centreBlock (juce::Rectangle<int>& area, int blockHeight)
    {
        const auto slack = area.getHeight() - blockHeight;

        if (slack > 0)
            area.removeFromTop (slack / 2);
    }
}

// ---------------------------------------------------------------------------
// KnobControl
// ---------------------------------------------------------------------------
KnobControl::KnobControl (juce::AudioProcessorValueTreeState& state,
                          const juce::String& parameterID,
                          const juce::String& caption,
                          const juce::String& suffix)
    : captionText (caption), attachment (state, parameterID, slider)
{
    slider.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
    slider.setRotaryParameters (juce::MathConstants<float>::pi * 1.25f,
                                juce::MathConstants<float>::pi * 2.75f, true);
    slider.setTextBoxStyle (juce::Slider::TextBoxBelow, false, 70, 13);
    slider.setTextValueSuffix (suffix);
    slider.setVelocityBasedMode (false);

    addAndMakeVisible (slider);
}

void KnobControl::resized()
{
    slider.setBounds (getLocalBounds().withTrimmedBottom (captionHeight));
}

void KnobControl::paint (juce::Graphics& g)
{
    g.setColour (Palette::textDim);
    g.setFont (CustomLookAndFeel::labelFont (8.5f));
    g.drawText (captionText, getLocalBounds().removeFromBottom (captionHeight),
                juce::Justification::centred, false);
}

// ---------------------------------------------------------------------------
// SliderControl
// ---------------------------------------------------------------------------
SliderControl::SliderControl (juce::AudioProcessorValueTreeState& state,
                              const juce::String& parameterID,
                              const juce::String& caption,
                              const juce::String& suffix)
    : captionText (caption), attachment (state, parameterID, slider)
{
    slider.setSliderStyle (juce::Slider::LinearHorizontal);
    slider.setTextBoxStyle (juce::Slider::TextBoxRight, false, 62, 16);
    slider.setTextValueSuffix (suffix);

    addAndMakeVisible (slider);
}

void SliderControl::resized()
{
    slider.setBounds (getLocalBounds().withTrimmedLeft (captionWidth));
}

void SliderControl::paint (juce::Graphics& g)
{
    g.setColour (Palette::textDim);
    g.setFont (CustomLookAndFeel::labelFont (8.5f));
    g.drawText (captionText, getLocalBounds().removeFromLeft (captionWidth),
                juce::Justification::centredLeft, false);
}

// ---------------------------------------------------------------------------
// ChoiceControl
// ---------------------------------------------------------------------------
ChoiceControl::ChoiceControl (juce::AudioProcessorValueTreeState& state,
                              const juce::String& parameterID,
                              const juce::String& caption)
    : captionText (caption)
{
    if (auto* choice = dynamic_cast<juce::AudioParameterChoice*> (state.getParameter (parameterID)))
        box.addItemList (choice->choices, 1);
    else
        jassertfalse;   // this control only makes sense on a choice parameter

    addAndMakeVisible (box);

    attachment = std::make_unique<juce::AudioProcessorValueTreeState::ComboBoxAttachment> (
        state, parameterID, box);
}

void ChoiceControl::resized()
{
    auto block = getLocalBounds().withSizeKeepingCentre (getWidth(), captionHeight + 2 + 22);
    block.removeFromTop (captionHeight + 2);
    box.setBounds (block);
}

void ChoiceControl::paint (juce::Graphics& g)
{
    auto block = getLocalBounds().withSizeKeepingCentre (getWidth(), captionHeight + 2 + 22);

    g.setColour (Palette::textDim);
    g.setFont (CustomLookAndFeel::labelFont (8.5f));
    g.drawText (captionText, block.removeFromTop (captionHeight),
                juce::Justification::centredLeft, false);
}

// ---------------------------------------------------------------------------
// SwitchControl
// ---------------------------------------------------------------------------
SwitchControl::SwitchControl (juce::AudioProcessorValueTreeState& state,
                              const juce::String& parameterID,
                              const juce::String& text)
    : attachment (state, parameterID, button)
{
    button.setButtonText (text);
    button.setClickingTogglesState (true);
    addAndMakeVisible (button);
}

void SwitchControl::resized()
{
    button.setBounds (getLocalBounds());
}

// ---------------------------------------------------------------------------
// GlassCard
// ---------------------------------------------------------------------------
GlassCard::GlassCard (juce::String cardTitle, juce::Colour accent)
    : title (std::move (cardTitle)), accentColour (accent)
{
    setInterceptsMouseClicks (false, false);
}

juce::Rectangle<int> GlassCard::getContentBounds() const
{
    return getBounds().reduced (12, 10).withTrimmedTop (20);
}

void GlassCard::paint (juce::Graphics& g)
{
    CustomLookAndFeel::drawGlassPanel (g, getLocalBounds().toFloat().reduced (0.5f), 10.0f);

    if (title.isEmpty())
        return;

    auto header = getLocalBounds().reduced (12, 10).removeFromTop (16);
    auto dot = header.removeFromLeft (7);

    g.setColour (accentColour);
    g.fillEllipse (juce::Rectangle<float> (5.0f, 5.0f).withCentre (dot.toFloat().getCentre()));

    header.removeFromLeft (5);

    g.setColour (Palette::text);
    g.setFont (CustomLookAndFeel::displayFont (9.5f));
    g.drawText (title, header, juce::Justification::centredLeft, false);
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
SomaticPulseEditor::SomaticPulseEditor (SomaticPulseProcessor& p)
    : AudioProcessorEditor (&p),
      processor (p),
      topBar ({}, Palette::cyan),
      coreCard ("BINAURAL CORE", Palette::cyan),
      pulseCard ("SOMATIC PULSE", Palette::violet),
      resonanceCard ("RESONANCE", Palette::cyan),
      mixCard ("PHASE & MIX", Palette::violet),
      visualizer (p.getScopeBuffer(), [&p] { return p.getLfoValueForUI(); }),
      headphoneSwitch (p.apvts, P::headphoneMode, "HEADPHONES"),
      limiterSwitch   (p.apvts, P::limiterEnable, "LIMITER"),
      outputSlider    (p.apvts, P::outputGainDb, "OUTPUT", " dB"),
      ceilingSlider   (p.apvts, P::ceilingDb, "CEILING", " dB"),
      oscEnableSwitch (p.apvts, P::oscEnable, "SUB OSCILLATOR"),
      carrierKnob     (p.apvts, P::carrierHz, "CARRIER", " Hz"),
      beatKnob        (p.apvts, P::beatHz, "BEAT", " Hz"),
      subLevelKnob    (p.apvts, P::subLevelDb, "LEVEL", " dB"),
      driveKnob       (p.apvts, P::oscDrive, "WARMTH", " %"),
      waveChoice      (p.apvts, P::oscWave, "WAVEFORM"),
      lfoEnableSwitch (p.apvts, P::lfoEnable, "PULSE"),
      lfoSyncSwitch   (p.apvts, P::lfoSync, "SYNC"),
      shapeChoice     (p.apvts, P::lfoShape, "SHAPE"),
      divisionChoice  (p.apvts, P::lfoDivision, "DIVISION"),
      rateKnob        (p.apvts, P::lfoRateHz, "RATE", " Hz"),
      depthSubKnob    (p.apvts, P::lfoDepthSub, "SUB", " %"),
      depthAudioKnob  (p.apvts, P::lfoDepthAudio, "AUDIO", " %"),
      depthFilterKnob (p.apvts, P::lfoDepthFilter, "FILTER", " %"),
      stereoPhaseKnob (p.apvts, P::lfoStereoPhase, "SPREAD", " deg"),
      resoEnableSwitch (p.apvts, P::resoEnable, "RESONATE"),
      detuneEnableSwitch (p.apvts, P::detuneEnable, "RETUNE"),
      resoBaseKnob    (p.apvts, P::resoBaseHz, "BASE", " Hz"),
      resoQKnob       (p.apvts, P::resoQ, "Q"),
      resoAmountKnob  (p.apvts, P::resoAmount, "AMOUNT", " %"),
      harmonicsKnob   (p.apvts, P::resoHarmonics, "HARMONICS"),
      detuneKnob      (p.apvts, P::detuneCents, "DETUNE", " ct"),
      duckEnableSwitch (p.apvts, P::duckEnable, "DUCK SUB TO TRACK"),
      duckAmountKnob  (p.apvts, P::duckAmount, "AMOUNT", " %"),
      duckAttackKnob  (p.apvts, P::duckAttackMs, "ATTACK", " ms"),
      duckReleaseKnob (p.apvts, P::duckReleaseMs, "RELEASE", " ms"),
      crossoverKnob   (p.apvts, P::crossoverHz, "MONO BELOW", " Hz"),
      dryWetKnob      (p.apvts, P::dryWet, "DRY/WET", " %")
{
    setLookAndFeel (&customLookAndFeel);
    setOpaque (true);

    titleLabel.setText ("SOMATICPULSE", juce::dontSendNotification);
    titleLabel.setFont (CustomLookAndFeel::displayFont (17.0f));
    titleLabel.setColour (juce::Label::textColourId, Palette::text);

    taglineLabel.setText ("PSYCHOACOUSTIC RESONANCE ENGINE", juce::dontSendNotification);
    taglineLabel.setFont (CustomLookAndFeel::labelFont (8.0f));
    taglineLabel.setColour (juce::Label::textColourId, Palette::textDim);

    presetCaption.setText ("PRESET", juce::dontSendNotification);
    presetCaption.setFont (CustomLookAndFeel::labelFont (8.5f));
    presetCaption.setColour (juce::Label::textColourId, Palette::textDim);

    buildPresetBox();

    addAndMakeVisible (content);

    // Cards first so every control paints on top of its panel.
    for (auto* card : { &topBar, &coreCard, &pulseCard, &resonanceCard, &mixCard })
        content.addAndMakeVisible (*card);

    content.addAndMakeVisible (visualizer);

    for (auto* component : std::initializer_list<juce::Component*> {
             &titleLabel, &taglineLabel, &presetCaption, &presetBox,
             &headphoneSwitch, &limiterSwitch, &outputSlider, &ceilingSlider,
             &oscEnableSwitch, &carrierKnob, &beatKnob, &subLevelKnob, &driveKnob, &waveChoice,
             &lfoEnableSwitch, &lfoSyncSwitch, &shapeChoice, &divisionChoice,
             &rateKnob, &depthSubKnob, &depthAudioKnob, &depthFilterKnob, &stereoPhaseKnob,
             &resoEnableSwitch, &detuneEnableSwitch, &resoBaseKnob, &resoQKnob,
             &resoAmountKnob, &harmonicsKnob, &detuneKnob,
             &duckEnableSwitch, &duckAmountKnob, &duckAttackKnob, &duckReleaseKnob,
             &crossoverKnob, &dryWetKnob })
        content.addAndMakeVisible (*component);

    setResizable (true, true);
    setResizeLimits (designWidth * 4 / 5, designHeight * 4 / 5,
                     designWidth * 2, designHeight * 2);

    if (auto* constrainer = getConstrainer())
        constrainer->setFixedAspectRatio (static_cast<double> (designWidth)
                                          / static_cast<double> (designHeight));

    setSize (designWidth, designHeight);

    // Only job is keeping the preset box in step with host-side program
    // changes, so 4 Hz is plenty - the scope has its own 60 Hz timer.
    startTimerHz (4);
}

SomaticPulseEditor::~SomaticPulseEditor()
{
    stopTimer();
    setLookAndFeel (nullptr);
}

void SomaticPulseEditor::buildPresetBox()
{
    for (int i = 0; i < processor.getNumPrograms(); ++i)
        presetBox.addItem (processor.getProgramName (i), i + 1);

    presetBox.setSelectedItemIndex (processor.getCurrentProgram(), juce::dontSendNotification);
    presetBox.setTextWhenNothingSelected ("Custom");

    presetBox.onChange = [this]
    {
        const auto index = presetBox.getSelectedItemIndex();

        if (index >= 0)
        {
            processor.setCurrentProgram (index);
            processor.updateHostDisplay();
        }
    };
}

void SomaticPulseEditor::timerCallback()
{
    const auto index = processor.getCurrentProgram();

    if (presetBox.getSelectedItemIndex() != index)
        presetBox.setSelectedItemIndex (index, juce::dontSendNotification);
}

void SomaticPulseEditor::paint (juce::Graphics& g)
{
    g.fillAll (Palette::background);

    const auto w = static_cast<float> (getWidth());
    const auto h = static_cast<float> (getHeight());

    g.setGradientFill (juce::ColourGradient (Palette::cyan.withAlpha (0.10f), w * 0.22f, -h * 0.1f,
                                             juce::Colours::transparentBlack, w * 0.22f, h * 0.8f,
                                             true));
    g.fillAll();

    g.setGradientFill (juce::ColourGradient (Palette::violet.withAlpha (0.10f), w * 0.86f, h * 1.05f,
                                             juce::Colours::transparentBlack, w * 0.86f, h * 0.1f,
                                             true));
    g.fillAll();
}

void SomaticPulseEditor::resized()
{
    const auto scale = static_cast<float> (getWidth()) / static_cast<float> (designWidth);

    content.setTransform (juce::AffineTransform::scale (scale));
    content.setBounds (0, 0, designWidth, designHeight);

    layoutContent();
}

// ---------------------------------------------------------------------------
void SomaticPulseEditor::layoutContent()
{
    auto area = juce::Rectangle<int> (0, 0, designWidth, designHeight).reduced (14, 12);

    // --- Top bar -----------------------------------------------------------
    auto bar = area.removeFromTop (56);
    topBar.setBounds (bar);

    {
        auto inner = bar.reduced (14, 8);

        auto titleArea = inner.removeFromLeft (196);
        titleLabel.setBounds (titleArea.removeFromTop (24));
        taglineLabel.setBounds (titleArea);
        inner.removeFromLeft (16);

        auto sliders = inner.removeFromRight (240);
        outputSlider.setBounds (sliders.removeFromTop (19));
        sliders.removeFromTop (2);
        ceilingSlider.setBounds (sliders.removeFromTop (19));
        inner.removeFromRight (16);

        auto switches = inner.removeFromRight (126);
        headphoneSwitch.setBounds (switches.removeFromTop (17));
        switches.removeFromTop (6);
        limiterSwitch.setBounds (switches.removeFromTop (17));
        inner.removeFromRight (16);

        presetCaption.setBounds (inner.removeFromLeft (46));
        presetBox.setBounds (inner.withSizeKeepingCentre (juce::jmin (210, inner.getWidth()), 24)
                                  .withX (inner.getX()));
    }

    area.removeFromTop (10);
    visualizer.setBounds (area.removeFromTop (170));
    area.removeFromTop (10);

    // --- Cards -------------------------------------------------------------
    auto cards = area.removeFromTop (290);

    constexpr int cardGap = 10;
    const auto cardWidth = (cards.getWidth() - cardGap * 3) / 4;

    coreCard.setBounds (cards.removeFromLeft (cardWidth));
    cards.removeFromLeft (cardGap);
    pulseCard.setBounds (cards.removeFromLeft (cardWidth));
    cards.removeFromLeft (cardGap);
    resonanceCard.setBounds (cards.removeFromLeft (cardWidth));
    cards.removeFromLeft (cardGap);
    mixCard.setBounds (cards);

    constexpr int switchRow = 17;
    constexpr int knobRow = 82;
    constexpr int choiceRow = 34;

    {
        auto c = coreCard.getContentBounds();
        centreBlock (c, switchRow + 8 + knobRow + 4 + knobRow);
        layoutRow (c, switchRow, 8, { &oscEnableSwitch });
        c.removeFromTop (8);
        layoutRow (c, knobRow, 6, { &carrierKnob, &beatKnob, &subLevelKnob });
        c.removeFromTop (4);
        layoutRow (c, knobRow, 6, { &driveKnob, &waveChoice });
    }

    {
        auto c = pulseCard.getContentBounds();
        centreBlock (c, switchRow + 8 + choiceRow + 6 + knobRow + 4 + knobRow);
        layoutRow (c, switchRow, 8, { &lfoEnableSwitch, &lfoSyncSwitch });
        c.removeFromTop (8);
        layoutRow (c, choiceRow, 8, { &shapeChoice, &divisionChoice });
        c.removeFromTop (6);
        layoutRow (c, knobRow, 6, { &rateKnob, &depthSubKnob, &depthAudioKnob });
        c.removeFromTop (4);
        layoutRow (c, knobRow, 6, { &depthFilterKnob, &stereoPhaseKnob, nullptr });
    }

    {
        auto c = resonanceCard.getContentBounds();
        centreBlock (c, switchRow + 8 + knobRow + 4 + knobRow);
        layoutRow (c, switchRow, 8, { &resoEnableSwitch, &detuneEnableSwitch });
        c.removeFromTop (8);
        layoutRow (c, knobRow, 6, { &resoBaseKnob, &resoQKnob, &resoAmountKnob });
        c.removeFromTop (4);
        layoutRow (c, knobRow, 6, { &harmonicsKnob, &detuneKnob, nullptr });
    }

    {
        auto c = mixCard.getContentBounds();
        centreBlock (c, switchRow + 8 + knobRow + 4 + knobRow);
        layoutRow (c, switchRow, 8, { &duckEnableSwitch });
        c.removeFromTop (8);
        layoutRow (c, knobRow, 6, { &duckAmountKnob, &duckAttackKnob, &duckReleaseKnob });
        c.removeFromTop (4);
        layoutRow (c, knobRow, 6, { &crossoverKnob, &dryWetKnob, nullptr });
    }
}
} // namespace SomaticPulse
