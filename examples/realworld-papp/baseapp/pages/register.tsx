import Wrapper from '../components/common/wrapper';
import CustomButton from '../components/common/CustomButton';
import guestOnly from '../lib/auth/guest-only';
import { login } from '../adapters/oidc';
function Login() { return <Wrapper title="Sign in"><div className="container mx-auto mt-12"><h1>Sign in</h1><CustomButton onClick={() => login()}>Sign in with identity provider</CustomButton></div></Wrapper>; }
export default guestOnly(Login);
