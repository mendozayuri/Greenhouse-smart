# Wiring (2-channel relay board, 5 V powerbank)

Rails: **5V red rail** (powerbank) · **3V3 red rail** (sensors) · **blue rail = GND for everything**.
Join the two blue rails with a wire, and connect the ESP32 GND to the blue rail.

## Relay board header
| Relay pin | Goes to |
|---|---|
| VCC | 5V rail |
| GND | Blue rail |
| IN1 | ESP32 D25 (pump) |
| IN2 | ESP32 D26 (fan) |
| JD-VCC | nothing (keep the cap on JD-VCC/VCC) |

## Load side, same pattern for K1 (pump) and K2 (fan)
5V rail -> **COM** (middle screw) · **NO** -> breadboard column -> device red (+) wire ·
device black (-) wire -> blue rail · **1N4007 diode across the device, band on the red (+) side**.
Leave **NC** empty. Find NO by testing (multimeter beep) if the board has no labels.

## Sensors (3V3 rail)
| Part | Pin |
|---|---|
| DHT11 data | GPIO4 |
| Soil moisture AO | GPIO34 |
| LDR module DO | GPIO35 |

## LED light (no relay)
GPIO27 -> 220-330 ohm resistor -> LED long leg; LED short leg -> blue rail. Lights when the LDR sees dark.

## Other
GPIO23 -> resistor -> LED (fan indicator) · GPIO22 buzzer (beeps in FAULT).

## Safety
Never use a needle or pin as a connector. Cover every bare join. Keep wires and the powerbank away from water.
No red (5V) wire may touch the blue rail. Unplug before changing wires. The fan and pump must be 5 V types.
