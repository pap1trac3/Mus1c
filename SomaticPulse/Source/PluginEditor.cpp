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

    juce::String formatClock (float seconds)
    {
        const auto total = juce::jmax (0, juce::roundToInt (seconds));

        return juce::String (total / 60).paddedLeft ('0', 2) + ":"
             + juce::String (total % 60).paddedLeft ('0', 2);
    }

    juce::String formatLufs (float lufs)
    {
        return lufs <= -69.9f ? juce::String ("-inf") : juce::String (lufs, 1);
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
// CarrierScale
// ---------------------------------------------------------------------------
CarrierScale::CarrierScale (juce::AudioProcessorValueTreeState& state,
                            const juce::String& parameterID)
    : parameter (state.getParameter (parameterID))
{
    jassert (parameter != nullptr);
    setInterceptsMouseClicks (false, false);
}

float CarrierScale::positionFor (float hz)
{
    // Log scale: the interesting zones are octave-shaped, so a linear strip
    // would squash everything below 150 Hz into the first fifth of it.
    const auto clamped = juce::jlimit (minHz, maxHz, hz);
    const auto lo = std::log (minHz);
    const auto hi = std::log (maxHz);

    return (std::log (clamped) - lo) / (hi - lo);
}

void CarrierScale::refresh()
{
    if (parameter == nullptr)
        return;

    const auto value = parameter->convertFrom0to1 (parameter->getValue());

    if (std::abs (value - lastValue) > 0.01f)
    {
        lastValue = value;
        repaint();
    }
}

void CarrierScale::paint (juce::Graphics& g)
{
    struct Zone { float from, to; const char* label; };

    static const Zone zones[] = {
        { 30.0f,  60.0f,  "SUB"  },   // felt as pressure more than vibration
        { 60.0f,  150.0f, "BODY" },   // where measured vibrators sit, 43-148 Hz
        { 150.0f, 400.0f, "PEAK" },   // Pacinian peak near 250 Hz
        { 400.0f, 528.0f, "HI"   }
    };

    auto bounds = getLocalBounds().toFloat();
    auto bar = bounds.removeFromTop (7.0f);
    auto labels = bounds;

    for (const auto& zone : zones)
    {
        const auto x1 = bar.getX() + positionFor (zone.from) * bar.getWidth();
        const auto x2 = bar.getX() + positionFor (zone.to) * bar.getWidth();

        const auto inZone = lastValue >= zone.from && lastValue < zone.to;

        g.setColour (inZone ? Palette::cyan.withAlpha (0.45f)
                            : juce::Colour::fromFloatRGBA (1.0f, 1.0f, 1.0f, 0.07f));
        g.fillRect (juce::Rectangle<float> (x1 + 0.5f, bar.getY(),
                                            juce::jmax (1.0f, x2 - x1 - 1.0f), bar.getHeight()));

        g.setColour (inZone ? Palette::text : Palette::textDim);
        g.setFont (CustomLookAndFeel::labelFont (7.5f));
        g.drawText (zone.label,
                    juce::Rectangle<float> (x1, labels.getY(), x2 - x1, labels.getHeight()),
                    juce::Justification::centred, false);
    }

    const auto markerX = bar.getX() + positionFor (lastValue) * bar.getWidth();

    g.setColour (juce::Colours::white);
    g.fillRect (juce::Rectangle<float> (markerX - 1.0f, bar.getY() - 1.0f,
                                        2.0f, bar.getHeight() + 2.0f));
}

// ---------------------------------------------------------------------------
// ValueReadout
// ---------------------------------------------------------------------------
ValueReadout::ValueReadout (juce::String caption, Provider provider, juce::Colour colour)
    : captionText (std::move (caption)), read (std::move (provider)), valueColour (colour)
{
    setInterceptsMouseClicks (false, false);
}

void ValueReadout::refresh()
{
    if (read == nullptr)
        return;

    auto value = read();

    if (value != cachedValue)
    {
        cachedValue = std::move (value);
        repaint();
    }
}

void ValueReadout::paint (juce::Graphics& g)
{
    auto bounds = getLocalBounds();

    g.setColour (Palette::textDim);
    g.setFont (CustomLookAndFeel::labelFont (8.0f));
    g.drawText (captionText, bounds.removeFromTop (9), juce::Justification::centredLeft, false);

    g.setColour (valueColour);
    g.setFont (CustomLookAndFeel::valueFont (11.0f));
    g.drawText (cachedValue, bounds, juce::Justification::centredLeft, false);
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
      sessionCard ("SESSION", Palette::cyan),
      tactileCard ("TACTILE OUT", Palette::violet),
      visualizer (p.getScopeBuffer(), [&p] { return p.getLfoValueForUI(); }),
      headphoneSwitch (p.apvts, P::headphoneMode, "HEADPHONES"),
      limiterSwitch   (p.apvts, P::limiterEnable, "LIMITER"),
      outputSlider    (p.apvts, P::outputGainDb, "OUTPUT", " dB"),
      ceilingSlider   (p.apvts, P::ceilingDb, "CEILING", " dB"),
      oscEnableSwitch (p.apvts, P::oscEnable, "SUB OSCILLATOR"),
      carrierKnob     (p.apvts, P::carrierHz, "CARRIER", " Hz"),
      beatKnob        (p.apvts, P::beatHz, "BEAT", " Hz"),
      carrierScale    (p.apvts, P::carrierHz),
      subLevelKnob    (p.apvts, P::subLevelDb, "LEVEL", " dB"),
      driveKnob       (p.apvts, P::oscDrive, "WARMTH", " %"),
      waveChoice      (p.apvts, P::oscWave, "WAVEFORM"),
      beatModeChoice  (p.apvts, P::beatMode, "BEAT MODE"),
      lfoEnableSwitch (p.apvts, P::lfoEnable, "PULSE"),
      lfoSyncSwitch   (p.apvts, P::lfoSync, "SYNC"),
      shapeChoice     (p.apvts, P::lfoShape, "SHAPE"),
      divisionChoice  (p.apvts, P::lfoDivision, "DIVISION"),
      rateKnob        (p.apvts, P::lfoRateHz, "RATE"),
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
      dryWetKnob      (p.apvts, P::dryWet, "DRY/WET", " %"),
      rampSwitch         (p.apvts, P::rampEnable, "RAMP OVER SESSION"),
      sessionLengthKnob  (p.apvts, P::sessionMinutes, "LENGTH (MIN)"),
      sessionFadeKnob    (p.apvts, P::sessionFadePct, "FADE", " %"),
      rampBeatKnob       (p.apvts, P::rampBeatHz, "BEAT TARGET", " Hz"),
      rampRateKnob       (p.apvts, P::rampRateHz, "PULSE TARGET"),
      elapsedReadout ("ELAPSED",
                      [&p]
                      {
                          const auto length = p.getSessionLengthForUI();

                          if (length <= 0.0f)
                              return juce::String ("Off");

                          return formatClock (p.getSessionElapsedForUI()) + " / " + formatClock (length);
                      },
                      Palette::cyan),
      loudnessReadout ("LUFS-M", [&p] { return formatLufs (p.getLoudnessForUI()); }, Palette::text),
      loudnessMaxReadout ("MAX",
                          [&p]
                          {
                              const auto peak = p.getLoudnessMaxForUI();
                              return formatLufs (peak);
                          },
                          Palette::violet),
      tactileSwitch        (p.apvts, P::tactileEnable, "TACTILE SEND"),
      tactileRoutingChoice (p.apvts, P::tactileRouting, "ROUTING"),
      tactileLevelKnob     (p.apvts, P::tactileLevelDb, "LEVEL", " dB"),
      tactileHpKnob        (p.apvts, P::tactileHpHz, "HIGH-PASS", " Hz"),
      tactileLpKnob        (p.apvts, P::tactileLpHz, "LOW-PASS", " Hz"),
      tactileStatusReadout ("SECOND OUTPUT BUS",
                            [&p]
                            {
                                return juce::String (p.isTactileBusConnected() ? "Connected"
                                                                               : "Not routed");
                            },
                            Palette::textDim)
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

    restartButton.onClick = [this] { processor.restartSession(); };
    restartButton.setTooltip ("Start the session clock again from zero.");

    addAndMakeVisible (content);

    // Cards first so every control paints on top of its panel.
    for (auto* card : { &topBar, &coreCard, &pulseCard, &resonanceCard, &mixCard,
                        &sessionCard, &tactileCard })
        content.addAndMakeVisible (*card);

    content.addAndMakeVisible (visualizer);

    for (auto* component : std::initializer_list<juce::Component*> {
             &titleLabel, &taglineLabel, &presetCaption, &presetBox,
             &headphoneSwitch, &limiterSwitch, &outputSlider, &ceilingSlider,
             &oscEnableSwitch, &carrierKnob, &beatKnob, &carrierScale,
             &subLevelKnob, &driveKnob, &waveChoice, &beatModeChoice,
             &lfoEnableSwitch, &lfoSyncSwitch, &shapeChoice, &divisionChoice,
             &rateKnob, &depthSubKnob, &depthAudioKnob, &depthFilterKnob, &stereoPhaseKnob,
             &resoEnableSwitch, &detuneEnableSwitch, &resoBaseKnob, &resoQKnob,
             &resoAmountKnob, &harmonicsKnob, &detuneKnob,
             &duckEnableSwitch, &duckAmountKnob, &duckAttackKnob, &duckReleaseKnob,
             &crossoverKnob, &dryWetKnob,
             &rampSwitch, &restartButton, &sessionLengthKnob, &sessionFadeKnob, &rampBeatKnob, &rampRateKnob,
             &elapsedReadout, &loudnessReadout, &loudnessMaxReadout,
             &tactileSwitch, &tactileRoutingChoice, &tactileLevelKnob, &tactileHpKnob,
             &tactileLpKnob, &tactileStatusReadout })
        content.addAndMakeVisible (*component);

    setResizable (true, true);
    setResizeLimits (designWidth * 4 / 5, designHeight * 4 / 5,
                     designWidth * 2, designHeight * 2);

    if (auto* constrainer = getConstrainer())
        constrainer->setFixedAspectRatio (static_cast<double> (designWidth)
                                          / static_cast<double> (designHeight));

    setSize (designWidth, designHeight);

    // Drives the text readouts and the preset box. The scope has its own
    // 60 Hz timer; none of this needs to be faster than a clock display.
    startTimerHz (8);
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

    carrierScale.refresh();

    for (auto* readout : { &elapsedReadout, &loudnessReadout, &loudnessMaxReadout,
                           &tactileStatusReadout })
        readout->refresh();
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
    visualizer.setBounds (area.removeFromTop (164));
    area.removeFromTop (10);

    // --- First card row ----------------------------------------------------
    auto cards = area.removeFromTop (300);

    constexpr int cardGap = 10;
    const auto cardWidth = (cards.getWidth() - cardGap * 3) / 4;

    coreCard.setBounds (cards.removeFromLeft (cardWidth));
    cards.removeFromLeft (cardGap);
    pulseCard.setBounds (cards.removeFromLeft (cardWidth));
    cards.removeFromLeft (cardGap);
    resonanceCard.setBounds (cards.removeFromLeft (cardWidth));
    cards.removeFromLeft (cardGap);
    mixCard.setBounds (cards);

    area.removeFromTop (cardGap);

    // --- Second card row ---------------------------------------------------
    auto wideCards = area.removeFromTop (180);
    const auto wideWidth = (wideCards.getWidth() - cardGap) / 2;

    sessionCard.setBounds (wideCards.removeFromLeft (wideWidth));
    wideCards.removeFromLeft (cardGap);
    tactileCard.setBounds (wideCards);

    constexpr int switchRow = 17;
    constexpr int knobRow = 82;
    constexpr int shortKnobRow = 78;
    constexpr int choiceRow = 34;
    constexpr int scaleRow = 22;

    {
        auto c = coreCard.getContentBounds();
        centreBlock (c, switchRow + 6 + knobRow + 4 + scaleRow + 4 + knobRow + 4 + choiceRow);
        layoutRow (c, switchRow, 8, { &oscEnableSwitch });
        c.removeFromTop (6);
        layoutRow (c, knobRow, 6, { &carrierKnob, &beatKnob });
        c.removeFromTop (4);
        layoutRow (c, scaleRow, 0, { &carrierScale });
        c.removeFromTop (4);
        layoutRow (c, knobRow, 6, { &subLevelKnob, &driveKnob });
        c.removeFromTop (4);
        layoutRow (c, choiceRow, 8, { &waveChoice, &beatModeChoice });
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

    {
        auto c = sessionCard.getContentBounds();
        centreBlock (c, switchRow + 6 + shortKnobRow + 6 + scaleRow);

        auto top = c.removeFromTop (switchRow);
        restartButton.setBounds (top.removeFromRight (74));
        top.removeFromRight (10);
        rampSwitch.setBounds (top);

        c.removeFromTop (6);
        layoutRow (c, shortKnobRow, 8, { &sessionLengthKnob, &sessionFadeKnob,
                                         &rampBeatKnob, &rampRateKnob });
        c.removeFromTop (6);
        layoutRow (c, scaleRow, 10, { &elapsedReadout, &loudnessReadout, &loudnessMaxReadout });
    }

    {
        auto c = tactileCard.getContentBounds();
        centreBlock (c, choiceRow + 4 + shortKnobRow + 4 + scaleRow);
        layoutRow (c, choiceRow, 10, { &tactileSwitch, &tactileRoutingChoice });
        c.removeFromTop (4);
        layoutRow (c, shortKnobRow, 8, { &tactileLevelKnob, &tactileHpKnob, &tactileLpKnob });
        c.removeFromTop (4);
        layoutRow (c, scaleRow, 10, { &tactileStatusReadout, nullptr });
    }
}
} // namespace SomaticPulse
