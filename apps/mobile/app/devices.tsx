import { DevicesSection } from '../src/screens/Devices';
import { Page, Title } from '../src/ui/Primitives';

export default function Devices() {
  return <Page>
    <Title subtitle="Phones and browsers signed in to your school account.">Your devices</Title>
    <DevicesSection/>
  </Page>;
}
