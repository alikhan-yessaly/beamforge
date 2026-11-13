# BeamForge

**Draw. Prepare. Cut.** A browser-based workspace for Ruida laser controllers.

> **Beta:** BeamForge has been tested on one RDC644XS controller, not across
> all Ruida models. Sketch-generated cuts and fill have not yet been verified
> on physical hardware. Use only if you understand the risks and can supervise
> the machine throughout the job.

## What it does

- Import DXF drawings or create parametric sketches (dimensions, constraints, fillets, patterns, text), and edit
  imported DXF files as sketches.
- Arrange shapes on a machine bed, configure layers, and preview jobs. Cut outlines and engrave areas with
  separate speed and power: the Fill tool fills any closed area in a colour of its own.
- Prepare a job, then switch to Device mode to review it: a read-only toolpath preview, time and size, the cut
  order (object by object, layer by layer, or whichever is faster; fills always run before the cuts around them)
  and the layer order.
- Use the interface in English, Kazakh or Russian.
- Frame and run jobs over USB with supported desktop browsers, or save a job in the controller's memory under a
  name to start later from the machine's panel (not yet verified on hardware).
- Save projects locally and try the workspace with a simulator.

## Safety and limitations

**Never leave a laser running unattended.** Maintain the machine's interlocks,
ventilation and physical emergency stop. Software controls and the software
Stop are not substitutes for those safety devices.

Check the controller model, bed dimensions, origin, material and job placement
before operating. Frame the job and use conservative settings appropriate to
your machine and material. A result in the simulator does not prove a job is
safe or correct on hardware. Stop using the app if behavior is unexpected.
Before each job, review the safety reminders and confirm them with
**Confirm and start**; the app cannot verify those physical conditions.

Only one RDC644XS machine has been tested. Compatibility with other machines,
firmware and controllers is not established. Fill, sketch-generated cuts,
large jobs and recovery after connection problems need further hardware
validation.

## Get started

Use desktop Chrome or Edge with Web Serial in an HTTPS or localhost context.
Connect the controller by USB and select the correct device in the browser's
port chooser. The app runs in the browser; project data and machine preferences
are stored locally in the browser unless you save a project file.

To run locally, install Node.js 22, then:

```sh
npm ci
npm run dev
```

Open the localhost URL printed by Vite. Try the simulator before connecting
hardware. Run `npm test` and `npm run build` to validate changes.

## Feedback and contributions

Please report bugs and hardware compatibility results in the repository's
issue tracker. Remove personal data and machine identifiers from logs before
sharing. Describe your controller model, browser, steps to reproduce, and
whether you used the simulator or real hardware.

Use a branch and open a pull request for proposed changes.

## License

BeamForge is distributed under the [MIT License](LICENSE), which permits
personal and commercial use. Third-party packages retain their own licenses.
